// Routes for sending an approved run to Square and the scales. Every route is for a signed-in
// manager or admin (access 'user', checked in onRequest before any body is read). Every post
// carries the per-session CSRF token (checked in preHandler by app.ts), is checked again on the
// server against the run as stored, and is written to the audit log with the run id by the action
// it calls. Nothing the browser sends is trusted beyond the choice itself: scale names must be in
// the config, preview steps and digests must be the ones the run holds.

import { getPreview as getMailchimpPreview, taskForRun } from '../mailchimp/store.ts';
import { mailchimpSendSection } from './views/mailchimp-pages.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditActor } from '../db/audit.ts';
import { acceptSettles, acknowledgeScales, confirmLooked, requestLookup, requestScalePreview } from '../runs/scale-push.ts';
import { sendView } from '../runs/send-view.ts';
import { redoDryRun, requestCorrections, resolveWrite, runEnvironment, startSend, stopSend, type SendDeps } from '../runs/square-send.ts';
import type { Runner } from '../runs/runner.ts';
import { mustGetRun, RunError } from '../runs/store.ts';
import type { RouteKit } from './run-routes.ts';
import { sendPage } from './views/send-pages.ts';

export interface SendServices {
  deps: SendDeps;
  runner: Runner;
  /** Plain words for the page: where a send goes now. */
  where: () => string;
}

const SCALE_NAME = /^[A-Za-z0-9 _-]{1,32}$/;
const DIGEST = /^[0-9a-f]{32}$/;
/** At most this many drift boxes on one form: far more than any preview shows. */
const MAX_DRIFT_FIELDS = 1000;

export async function registerSendRoutes(app: FastifyInstance, kit: RouteKit, svc: SendServices): Promise<void> {
  const deps = svc.deps;
  const actorWithId = (req: FastifyRequest): AuditActor & { userId: number } => ({ ...kit.actorOf(req), userId: req.user!.userId });

  const show = (req: FastifyRequest, reply: FastifyReply, runId: number, status = 200, error?: string): FastifyReply => {
    const run = mustGetRun(deps.db, runId);
    const mailchimp = mailchimpSendSection(taskForRun(deps.db, runId), getMailchimpPreview(deps.db, runId, run.dryRunHash));
    return kit.sendPage(reply, status, sendPage({ user: req.user!, view: sendView(deps, run), where: svc.where(), error, mailchimp, live: runEnvironment(deps, run) === 'production' }));
  };

  /** Runs one action, then back to the send page. A refusal shows the page with the reason. */
  const act = (fn: (req: FastifyRequest, runId: number) => void) => async (req: FastifyRequest, reply: FastifyReply) => {
    const runId = kit.idParam(req);
    try {
      fn(req, runId);
      svc.runner.kick();
      return reply.redirect(`/runs/${runId}/send`, 303);
    } catch (err) {
      if (err instanceof RunError && err.status !== 404) return show(req, reply, runId, err.status, err.message);
      throw err;
    }
  };

  /** Every drift box ticked on the form: each field named drift_N, however many the page showed. */
  const driftFields = (req: FastifyRequest): string[] => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const names = Object.keys(body).filter((k) => /^drift_[0-9]{1,4}$/.test(k));
    if (names.length > MAX_DRIFT_FIELDS) throw new RunError('Too many differences on one form.', 400);
    const out: string[] = [];
    for (const name of names) {
      const t = kit.field(req, name);
      if (t === '') continue;
      if (t.length > 200 || /[\s<>]/.test(t)) throw new RunError('A difference on the page is not one this preview holds.', 400);
      out.push(t);
    }
    return out;
  };

  const scaleField = (req: FastifyRequest): string => {
    const s = kit.field(req, 'scale');
    if (!SCALE_NAME.test(s) || !deps.scaleNames.includes(s)) throw new RunError('That is not one of the scales.', 400);
    return s;
  };

  app.get('/runs/:id/send', { config: { access: 'user' } }, async (req, reply) => show(req, reply, kit.idParam(req)));

  // Sending, accepting a scale change and accepting a settle need the password typed recently.
  app.post('/runs/:id/send/start', { config: { access: 'user', recentPassword: true } }, act((req, id) => {
    const scales = deps.scaleNames.filter((s) => kit.field(req, `scale_${s}`) === '1');
    startSend(deps, id, actorWithId(req), { hash: kit.field(req, 'hash'), scales });
  }));

  app.post('/runs/:id/send/stop', { config: { access: 'user' } }, act((req, id) => stopSend(deps, id, actorWithId(req), kit.field(req, 'confirm') === '1')));

  app.post('/runs/:id/send/redo-dry-run', { config: { access: 'user' } }, act((req, id) => redoDryRun(deps, id, actorWithId(req))));

  app.post('/runs/:id/send/scale-preview', { config: { access: 'user' } }, act((req, id) => requestScalePreview(deps, id, actorWithId(req))));

  app.post('/runs/:id/send/scales', { config: { access: 'user', recentPassword: true } }, act((req, id) => {
    const stepRaw = kit.field(req, 'stepId');
    if (!/^[1-9][0-9]{0,9}$/.test(stepRaw)) throw new RunError('That scale preview is not the current one. Look at the page again.', 400);
    const warnings = kit.field(req, 'ack');
    if (warnings !== '' && !DIGEST.test(warnings)) throw new RunError('The warnings changed since the page was shown. Look at them again.', 400);
    acknowledgeScales(deps, id, actorWithId(req), { stepId: Number(stepRaw), warnings, drift: driftFields(req) });
  }));

  app.post('/runs/:id/send/lookup', { config: { access: 'user' } }, act((req, id) => requestLookup(deps, id, actorWithId(req))));

  app.post('/runs/:id/send/resend/look', { config: { access: 'user' } }, act((req, id) => confirmLooked(deps, id, actorWithId(req), scaleField(req), kit.field(req, 'looked') === '1')));

  app.post('/runs/:id/send/resend/accept', { config: { access: 'user', recentPassword: true } }, act((req, id) => {
    const digest = kit.field(req, 'digest');
    if (digest !== '' && !DIGEST.test(digest)) throw new RunError('The settle changed since the page was shown. Look at it again.', 400);
    acceptSettles(deps, id, actorWithId(req), scaleField(req), digest, driftFields(req));
  }));

  // A person checked Square for a write whose answer was lost, and says whether it landed.
  app.post('/runs/:id/send/writes/check', { config: { access: 'user', recentPassword: true } }, act((req, id) => {
    const raw = kit.field(req, 'writeId');
    if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new RunError('That Square write is not waiting for a person.', 400);
    const landed = kit.field(req, 'landed');
    if (landed !== 'yes' && landed !== 'no') throw new RunError('Say whether it landed in Square.', 400);
    resolveWrite(deps, id, actorWithId(req), Number(raw), landed, kit.field(req, 'confirm') === '1');
  }));

  app.post('/runs/:id/send/corrections', { config: { access: 'user', recentPassword: true } }, act((req, id) => requestCorrections(deps, id, actorWithId(req))));
}
