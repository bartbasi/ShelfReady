// Routes for shelf card sheets (src/runs/card-sheets.ts). Every route is for a signed-in manager
// or admin (access 'user', checked in onRequest before any body is read), and every post carries
// the per-session CSRF token (checked by app.ts). A sheet is found by its id and must belong to
// the run in the path. The browser never names a file or a product: reprint picks are places in
// the run's own approved card list, and the stored file name comes from the database.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditActor } from '../db/audit.ts';
import { buildReprint, buildRunSheet, DOCX_TYPE, downloadSheet, requestRecheck, type SheetDeps } from '../runs/card-sheets.ts';
import type { SheetChecker } from '../runs/sheet-check.ts';
import { getRun, RunError } from '../runs/store.ts';
import type { RouteKit } from './run-routes.ts';
import { errorPage } from './views/pages.ts';

export interface SheetServices {
  deps: SheetDeps;
  checker: SheetChecker;
}

/** Most cards one reprint may pick. A run has far fewer. */
const MAX_PICKS = 500;

function sheetParam(req: FastifyRequest): number {
  const raw = (req.params as { sheetId?: string }).sheetId ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new RunError('There is no such card sheet.', 404);
  return Number(raw);
}

/** Where to go back to: the dry run page when the form came from there, else the run page. */
function back(req: FastifyRequest, runId: number, field: (req: FastifyRequest, name: string) => string): string {
  return field(req, 'from') === 'dry-run' ? `/runs/${runId}/dry-run#sheet-h` : `/runs/${runId}#sheet-h`;
}

export async function registerSheetRoutes(app: FastifyInstance, kit: RouteKit, svc: SheetServices, show: (req: FastifyRequest, reply: FastifyReply, runId: number, status: number, error: string) => FastifyReply): Promise<void> {
  const deps = svc.deps;
  const actorWithId = (req: FastifyRequest): AuditActor & { userId: number } => ({ ...kit.actorOf(req), userId: req.user!.userId });

  /** Runs one action, then back to the page. A refusal shows the run page with the reason. */
  const act = (fn: (req: FastifyRequest, runId: number) => Promise<void> | void) => async (req: FastifyRequest, reply: FastifyReply) => {
    const runId = kit.idParam(req);
    if (!getRun(deps.db, runId)) return kit.sendPage(reply, 404, errorPage(404, 'There is no such invoice.', req.user));
    try {
      await fn(req, runId);
      svc.checker.kick();
      return reply.redirect(back(req, runId, kit.field), 303);
    } catch (err) {
      if (err instanceof RunError && err.status !== 404) return show(req, reply, runId, err.status, err.message);
      throw err;
    }
  };

  app.post('/runs/:id/card-sheet', { config: { access: 'user' } }, act(async (req, id) => {
    await buildRunSheet(deps, id, actorWithId(req));
  }));

  app.post('/runs/:id/card-sheet/reprint', { config: { access: 'user' } }, act(async (req, id) => {
    const picks: number[] = [];
    for (let i = 0; i < MAX_PICKS; i++) if (kit.field(req, `card_${i}`) === '1') picks.push(i);
    await buildReprint(deps, id, actorWithId(req), picks);
  }));

  app.post('/runs/:id/card-sheets/:sheetId/check', { config: { access: 'user' } }, act((req, id) => {
    requestRecheck(deps, id, sheetParam(req), actorWithId(req));
  }));

  // The file itself. Only for a sheet of this run, once its check allows it and Square has the
  // run's prices. Checked against its stored hash and audited.
  // GET only: no automatic HEAD route, so nothing but a real download is audited as one.
  app.get('/runs/:id/card-sheets/:sheetId', { config: { access: 'user' }, exposeHeadRoute: false }, async (req, reply) => {
    const runId = kit.idParam(req);
    const sheetId = sheetParam(req);
    if (!getRun(deps.db, runId)) return kit.sendPage(reply, 404, errorPage(404, 'There is no such invoice.', req.user));
    try {
      const file = downloadSheet(deps, runId, sheetId, actorWithId(req));
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      reply.header('Cache-Control', 'no-store');
      // sheetFileName makes only letters, digits and hyphens. Anything else is replaced, never quoted raw.
      const name = /^[a-z0-9-]{1,120}\.docx$/.test(file.fileName) ? file.fileName : `cards-${sheetId}.docx`;
      reply.header('Content-Disposition', `attachment; filename="${name}"`);
      return reply.type(DOCX_TYPE).send(file.buffer);
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
      if (err.status === 404) return kit.sendPage(reply, 404, errorPage(404, err.message, req.user));
      return show(req, reply, runId, err.status, err.message);
    }
  });
}
