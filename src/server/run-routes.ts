// Routes for invoice runs. Every route declares its access level; app.ts checks it in onRequest,
// before any body is read. Posts carry the per-session CSRF token. The upload is the only
// multipart route: multipart is registered for it alone, its size is checked from Content-Length
// before anything is read, and its CSRF token must be the first part, checked before any file.

import { getPreview as getMailchimpPreview } from '../mailchimp/store.ts';
import { mailchimpDryRunSection } from './views/mailchimp-pages.ts';
import { createHash } from 'node:crypto';
import { closeSync, writeSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { tokensEqual } from '../auth/csrf.ts';
import type { AuditActor } from '../db/audit.ts';
import { estimatePdfPages, sniffUpload, type UploadKind } from '../invoice/images.ts';
import type { UploadLimits } from '../invoice/settings.ts';
import { lineText, rankByName } from '../matching/similarity.ts';
import { catalogLabelFor, type CatalogSource } from '../square/catalog-source.ts';
import {
  acceptBigChange,
  acceptCheck,
  markNotArrived,
  setPack,
  approvalProblems,
  approveCost,
  approveRun,
  chooseSupplier,
  decideOverride,
  markNotForResale,
  pickConflictPrice,
  pickItem,
  readAgain,
  renameItem,
  requestDryRun,
  setArrived,
  skipLine,
  stopRun,
  undoDecision,
  type ActionDeps,
} from '../runs/actions.ts';
import { approveCardCosts, checkRunCard, confirmCard, editRunCard, leaveCardOut, rejectCard, writeCardCopy, type CardEditInput } from '../runs/card-actions.ts';
import { copyBudget, runCopySettings } from '../runs/card-copy.ts';
import type { RunCatalog } from '../runs/catalog-cache.ts';
import { usableVariation, type Evaluation } from '../runs/evaluate.ts';
import { displayName, ensureUploadDir, freeBytes, newStoredName, openNewFile, readStoredFile, removeStoredFile, UploadDirError } from '../runs/files.ts';
import { dryRunView, reviewView } from '../runs/review.ts';
import { evaluateRun, type Runner } from '../runs/runner.ts';
import { createRun, enqueueJob, getRun, listRuns, mustGetRun, recordUploadAttempt, runFiles, RunError, uploadAttemptsSince, uploadBytesSince, type StoredFile } from '../runs/store.ts';
import type { ServerConfig } from './config.ts';
import { dryRunPage, runListPage, runPage, searchPage, uploadPage } from './views/run-pages.ts';
import { sheetSection } from '../runs/card-sheets.ts';
import { registerSheetRoutes, type SheetServices } from './sheet-routes.ts';
import { errorPage } from './views/pages.ts';
import { createUploadSlots, type UploadSlots } from './upload-slots.ts';

export interface RouteKit {
  sendPage(reply: FastifyReply, status: number, body: string): FastifyReply;
  field(req: FastifyRequest, name: string): string;
  idParam(req: FastifyRequest): number;
  actorOf(req: FastifyRequest): AuditActor;
  now(): number;
}

export interface RunServices {
  config: ServerConfig;
  runner: Runner;
  catalogs: { get(snapshotId: number): RunCatalog };
  catalogSource: CatalogSource;
  actions: ActionDeps;
  /** The daily limit on readings and card copy, from the admin settings, in US dollars. */
  dailyLimitUsd(): number;
  uploadLimits: UploadLimits;
  /** Shelf card sheets for approved runs (src/runs/card-sheets.ts). */
  sheets?: SheetServices;
  /** Upload slots shared with the old invoice upload. Made here when not given. */
  uploadSlots?: UploadSlots;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The CSRF token comes as the first multipart part, checked by the route before any file is read. */
    multipartCsrf?: boolean;
  }
}

/** An upload that is refused, with a status and words safe to show. */
class UploadRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function lineParam(req: FastifyRequest): number {
  const raw = (req.params as { n?: string }).n ?? '';
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new RunError('There is no such line on this invoice.', 404);
  return Number(raw);
}

/** A Square variation id from a form. It is only ever compared with ids this run shows. */
function variationField(raw: string): string {
  if (raw === '' || raw.length > 100) throw new RunError('That item has no card on this invoice.', 400);
  return raw;
}

/** A card id or version from a form, as the digits the page showed. */
function numberField(raw: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new RunError('That card is not the one this invoice shows. Reload the page.', 400);
  return raw;
}

function fileParam(req: FastifyRequest): number {
  const raw = (req.params as { fileId?: string }).fileId ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new RunError('There is no such file.', 404);
  return Number(raw);
}

const CONTENT_TYPES: Record<UploadKind, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heif', pdf: 'application/pdf' };

export async function registerRunRoutes(app: FastifyInstance, kit: RouteKit, svc: RunServices): Promise<void> {
  const db = app.shelf.db;
  const limits = svc.uploadLimits;
  const actions = svc.actions;
  const signedIn = (req: FastifyRequest) => req.user!;
  const actorWithId = (req: FastifyRequest): AuditActor & { userId: number } => ({ ...kit.actorOf(req), userId: signedIn(req).userId });

  /** Renders the run page, or the progress page when there is nothing to review yet. */
  const showRun = (req: FastifyRequest, reply: FastifyReply, runId: number, status = 200, error?: string): FastifyReply => {
    const run = mustGetRun(db, runId);
    let ev: Evaluation | null = null;
    let catalog: RunCatalog | null = null;
    if (run.catalogSnapshotId !== null) {
      catalog = svc.catalogs.get(run.catalogSnapshotId);
      if (run.readResult) ev = evaluateRun(actions, run);
    }
    const budget = ev ? copyBudget(db, runId, runCopySettings(actions.settings).costCapUsd, svc.dailyLimitUsd(), kit.now()) : null;
    const view = reviewView(db, run, ev, catalog, catalog ? catalogLabelFor(svc.catalogSource, catalog.snapshot.source) : svc.catalogSource.label, budget);
    const sheets = svc.sheets && run.readResult ? sheetSection(db, run) : undefined;
    return kit.sendPage(reply, status, runPage({ user: signedIn(req), view, error, sheets }));
  };

  /** Runs one decision, then goes back to the run page at the line it was about. */
  const decide = (fn: (req: FastifyRequest, runId: number) => string | void) => async (req: FastifyRequest, reply: FastifyReply) => {
    const runId = kit.idParam(req);
    try {
      const anchor = fn(req, runId);
      svc.runner.kick();
      return reply.redirect(`/runs/${runId}${anchor ? `#${anchor}` : ''}`, 303);
    } catch (err) {
      if (err instanceof RunError) {
        if (!getRun(db, runId)) return kit.sendPage(reply, 404, errorPage(404, err.message, req.user));
        return showRun(req, reply, runId, err.status, err.message);
      }
      throw err;
    }
  };

  app.get('/runs', { config: { access: 'user' } }, async (req, reply) =>
    kit.sendPage(reply, 200, runListPage({ user: signedIn(req), runs: listRuns(db), catalogLabel: svc.catalogSource.label })),
  );

  app.get('/runs/new', { config: { access: 'user' } }, async (req, reply) =>
    kit.sendPage(
      reply,
      200,
      uploadPage({ user: signedIn(req), maxFiles: limits.maxFiles, maxFileMb: Math.round(limits.maxFileBytes / (1024 * 1024)), maxPdfPages: limits.maxPdfPages, catalogLabel: svc.catalogSource.label }),
    ),
  );

  // Uploads in progress, per person and in all, shared with old invoices (src/server/upload-slots.ts).
  const slots = svc.uploadSlots ?? createUploadSlots();

  const uploadError = (req: FastifyRequest, reply: FastifyReply, status: number, message: string): FastifyReply => {
    // The rest of a refused body is not read.
    reply.header('Connection', 'close');
    return kit.sendPage(
      reply,
      status,
      uploadPage({ user: signedIn(req), maxFiles: limits.maxFiles, maxFileMb: Math.round(limits.maxFileBytes / (1024 * 1024)), maxPdfPages: limits.maxPdfPages, catalogLabel: svc.catalogSource.label, error: message }),
    );
  };

  // The upload, in its own scope so multipart is parsed here and nowhere else.
  await app.register(async (scope) => {
    await scope.register(fastifyMultipart, {
      limits: { files: limits.maxFiles, fileSize: limits.maxFileBytes, fields: 4, fieldSize: 256, fieldNameSize: 32, parts: limits.maxFiles * 2 + 4, headerPairs: 20 },
      throwFileSizeLimit: true,
    });

    scope.post(
      '/runs',
      {
        config: { access: 'user', multipartCsrf: true },
        // After the access check, before anything is read: the attempt is counted, then the
        // rate, the size, the daily budget, free space, and an upload slot.
        onRequest: async (req, reply) => {
          if (!req.user) return;
          const u = svc.config.uploads;
          const userId = req.user.userId;
          if (uploadAttemptsSince(db, userId, kit.now() - 3600_000) >= u.perUserPerHour) {
            // Already over: not recorded again, so a flood adds no rows.
            return uploadError(req, reply, 429, 'You have tried a lot of uploads in the last hour. Wait a while and try again.');
          }
          recordUploadAttempt(db, userId, kit.now());
          const len = req.headers['content-length'];
          if (len === undefined) return uploadError(req, reply, 411, 'The upload did not say how large it is. Try again from the upload page.');
          if (!/^\d{1,12}$/.test(len) || Number(len) > u.maxTotalBytes) {
            return uploadError(req, reply, 413, `That upload is too large. The limit is ${Math.round(u.maxTotalBytes / (1024 * 1024))} MB in all.`);
          }
          const dayAgo = kit.now() - 24 * 3600_000;
          if (uploadBytesSince(db, dayAgo, userId) + Number(len) > u.maxBytesPerUserPerDay) {
            return uploadError(req, reply, 429, 'Your uploads today have reached your daily share. Try again tomorrow, or ask Bart.');
          }
          if (uploadBytesSince(db, dayAgo) + Number(len) > u.maxBytesPerDay) {
            return uploadError(req, reply, 429, 'Uploads today have reached the daily limit. Try again tomorrow, or ask Bart.');
          }
          try {
            ensureUploadDir(u.dir);
            if (freeBytes(u.dir) < u.minFreeBytes + Number(len)) return uploadError(req, reply, 507, 'The disk is nearly full, so the upload was refused. Tell Bart.');
          } catch (err) {
            if (err instanceof UploadDirError) return uploadError(req, reply, 500, err.message);
            throw err;
          }
          // The slot is held until the response is done or the connection closes, whichever first.
          const release = slots.take(userId, u);
          if (!release) return uploadError(req, reply, 429, 'Another upload is still in progress. Wait for it to finish.');
          reply.raw.once('close', release);
          reply.raw.once('finish', release);
          (req as unknown as { releaseUpload: () => void }).releaseUpload = release;
        },
        onResponse: async (req) => {
          (req as unknown as { releaseUpload?: () => void }).releaseUpload?.();
        },
        // The CSRF token must be the first part. Nothing after it is read until it checks out.
        preHandler: async (req, reply) => {
          if (!req.isMultipart()) return uploadError(req, reply, 415, 'Use the upload form.');
          const parts = req.parts();
          let ok = false;
          try {
            const first = await parts.next();
            ok = !first.done && first.value.type === 'field' && first.value.fieldname === '_csrf' && tokensEqual(String(first.value.value), signedIn(req).csrfToken);
          } catch {
            ok = false;
          }
          if (!ok) {
            req.log.warn({ path: '/runs', user: signedIn(req).username }, 'refused an upload with a bad csrf token');
            reply.header('Connection', 'close');
            return kit.sendPage(reply, 403, errorPage(403, 'That form has expired. Reload the page and try again.', req.user));
          }
          (req as unknown as { shelfParts: typeof parts }).shelfParts = parts;
        },
      },
      async (req, reply) => {
        const parts = (req as unknown as { shelfParts: AsyncIterableIterator<any> }).shelfParts;
        const dir = svc.config.uploads.dir;
        const saved: StoredFile[] = [];
        let total = 0;
        try {
          for await (const part of parts) {
            if (part.type !== 'file') throw new UploadRefused(400, 'That form was not filled in as expected.');
            if (part.fieldname !== 'files') throw new UploadRefused(400, 'That form was not filled in as expected.');
            const storedName = newStoredName();
            const fd = openNewFile(dir, storedName);
            const hash = createHash('sha256');
            let head = Buffer.alloc(0);
            let bytes = 0;
            let kind: UploadKind | null = null;
            const entry: StoredFile = { storedName, originalName: '', kind: 'jpeg', bytes: 0, sha256: '' };
            saved.push(entry);
            try {
              for await (const chunk of part.file as AsyncIterable<Buffer>) {
                bytes += chunk.length;
                total += chunk.length;
                if (total > svc.config.uploads.maxTotalBytes) throw new UploadRefused(413, 'That upload is too large.');
                if (kind === null) {
                  head = Buffer.concat([head, chunk]).subarray(0, 64);
                  if (head.length >= 16) {
                    kind = sniffUpload(head);
                    if (kind === null) throw new UploadRefused(415, `${displayName(part.filename, 'A file')} is not a JPEG, PNG, WebP or HEIF photo, or a PDF.`);
                  }
                }
                writeSync(fd, chunk);
                hash.update(chunk);
              }
            } finally {
              closeSync(fd);
            }
            // A file box left empty still sends an empty part. Skip it.
            if (bytes === 0) {
              removeStoredFile(dir, storedName);
              saved.pop();
              continue;
            }
            if (kind === null) kind = sniffUpload(head);
            if (kind === null) throw new UploadRefused(415, `${displayName(part.filename, 'A file')} is not a JPEG, PNG, WebP or HEIF photo, or a PDF.`);
            Object.assign(entry, { originalName: displayName(part.filename, `file ${saved.length}`), kind, bytes, sha256: hash.digest('hex') });
          }
          if (saved.length === 0) throw new UploadRefused(400, 'Choose at least one photo or a PDF.');
          if (saved.length > limits.maxFiles) throw new UploadRefused(413, `At most ${limits.maxFiles} files can be read at once.`);
          const pdfs = saved.filter((f) => f.kind === 'pdf');
          if (pdfs.length && saved.length > 1) throw new UploadRefused(400, 'Upload either photos of the pages or one PDF, not both and not several PDFs.');
          if (pdfs.length === 1 && estimatePdfPages(readStoredFile(dir, pdfs[0]!.storedName)) > limits.maxPdfPages) {
            throw new UploadRefused(413, `That PDF has more than ${limits.maxPdfPages} pages.`);
          }
        } catch (err) {
          for (const f of saved) removeStoredFile(dir, f.storedName);
          if (err instanceof UploadRefused) return uploadError(req, reply, err.status, err.message);
          const e = err as { code?: string; statusCode?: number };
          if (e.code === 'FST_REQ_FILE_TOO_LARGE') return uploadError(req, reply, 413, `A file is larger than ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB.`);
          if (e.code === 'FST_FILES_LIMIT') return uploadError(req, reply, 413, `At most ${limits.maxFiles} files can be read at once.`);
          if (e.code === 'FST_PARTS_LIMIT' || e.code === 'FST_FIELDS_LIMIT') return uploadError(req, reply, 413, 'That form has too many parts.');
          if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) return uploadError(req, reply, 400, 'The upload could not be read. Try again.');
          throw err;
        }
        let runId: number;
        try {
          runId = createRun(db, actorWithId(req), saved, kit.now(), svc.config.uploads.perUserPerHour);
        } catch (err) {
          for (const f of saved) removeStoredFile(dir, f.storedName);
          if (err instanceof RunError) return uploadError(req, reply, err.status, err.message);
          throw err;
        }
        enqueueJob(db, runId, 'process', signedIn(req).userId, kit.now());
        svc.runner.kick();
        return reply.redirect(`/runs/${runId}`, 303);
      },
    );
  });

  app.get('/runs/:id', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    if (!getRun(db, runId)) return kit.sendPage(reply, 404, errorPage(404, 'There is no such invoice.', req.user));
    return showRun(req, reply, runId);
  });

  // An uploaded file, for signed-in users only. Photos show inline; PDF and HEIF download.
  // The stored name is looked up by id, never taken from the request.
  app.get('/runs/:id/files/:fileId', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    const fileId = fileParam(req);
    const f = runFiles(db, runId).find((x) => x.id === fileId);
    if (!f) return kit.sendPage(reply, 404, errorPage(404, 'There is no such file.', req.user));
    const inline = f.kind === 'jpeg' || f.kind === 'png' || f.kind === 'webp';
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="invoice-${runId}-${f.position}.${f.kind === 'jpeg' ? 'jpg' : f.kind}"`);
    return reply.type(CONTENT_TYPES[f.kind]).send(readStoredFile(svc.config.uploads.dir, f.storedName));
  });

  app.get('/runs/:id/lines/:n/search', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    const n = lineParam(req);
    const run = mustGetRun(db, runId);
    if (run.catalogSnapshotId === null || !run.readResult) return reply.redirect(`/runs/${runId}`, 303);
    const ev = evaluateRun(actions, run);
    const line = ev.lines.find((l) => l.n === n);
    if (!line) return kit.sendPage(reply, 404, errorPage(404, 'There is no such line on this invoice.', req.user));
    const q = String((req.query as { q?: unknown }).q ?? '').slice(0, 100);
    const catalog = svc.catalogs.get(run.catalogSnapshotId);
    const results = q.trim()
      ? rankByName(catalog.index, lineText({ description: q, brand: '', unit: '', weight: '', pack_size: '' }), { limit: 15, minScore: 0.05 })
          .filter((s) => usableVariation(catalog, s.variation.id))
          .map((s) => ({ variationId: s.variation.id, label: s.variation.label, scorePercent: Math.round(s.score * 100), method: 'name', reasons: s.reasons }))
      : [];
    const header = ['review', 'ready', 'dry_run_done'].includes(run.state);
    return kit.sendPage(reply, 200, searchPage({ user: signedIn(req), runId, n, description: line.line.line.description, q, results, canDecide: header }));
  });

  app.get('/runs/:id/dry-run', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    const run = getRun(db, runId);
    if (!run) return kit.sendPage(reply, 404, errorPage(404, 'There is no such invoice.', req.user));
    const problems = run.state === 'approved' ? [] : approvalProblems(actions, run, null);
    const view = dryRunView(db, run, problems);
    if (!view) return reply.redirect(`/runs/${runId}`, 303);
    return kit.sendPage(reply, 200, dryRunPage({ user: signedIn(req), view, sheets: svc.sheets ? sheetSection(db, run) : undefined, mailchimp: mailchimpDryRunSection(getMailchimpPreview(db, run.id, run.dryRunHash)) }));
  });

  // Decisions. Each one is checked against the run's own catalog and audited.
  const f = kit.field;
  app.post('/runs/:id/lines/:n/pick', { config: { access: 'user' } }, decide((req, id) => {
    const n = lineParam(req);
    pickItem(actions, id, kit.actorOf(req), n, f(req, 'variationId'));
    return `line-${n}`;
  }));
  app.post('/runs/:id/lines/:n/not-for-resale', { config: { access: 'user' } }, decide((req, id) => {
    const n = lineParam(req);
    markNotForResale(actions, id, kit.actorOf(req), n, f(req, 'confirm') === '1');
    return `line-${n}`;
  }));
  app.post('/runs/:id/lines/:n/pack', { config: { access: 'user' } }, decide((req, id) => {
    const n = lineParam(req);
    setPack(actions, id, kit.actorOf(req), n, { unitsPerCase: f(req, 'unitsPerCase'), poundsPerUnit: f(req, 'poundsPerUnit') });
    return `line-${n}`;
  }));
  app.post('/runs/:id/big-change', { config: { access: 'user' } }, decide((req, id) => {
    acceptBigChange(actions, id, kit.actorOf(req), f(req, 'variationId'), f(req, 'fromCents'), f(req, 'toCents'));
  }));
  // After approval: a line that did not arrive. Recorded now; step 7 takes the stock back out of Square.
  app.post('/runs/:id/lines/:n/not-arrived', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    try {
      markNotArrived(actions, runId, kit.actorOf(req), lineParam(req), f(req, 'confirm') === '1');
      return reply.redirect(`/runs/${runId}/dry-run`, 303);
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
      const run = getRun(db, runId);
      const view = run ? dryRunView(db, run, []) : null;
      if (!view) return kit.sendPage(reply, err.status, errorPage(err.status, err.message, req.user));
      return kit.sendPage(reply, err.status, dryRunPage({ user: signedIn(req), view, error: err.message }));
    }
  });
  app.post('/runs/:id/lines/:n/skip', { config: { access: 'user' } }, decide((req, id) => {
    const n = lineParam(req);
    skipLine(actions, id, kit.actorOf(req), n, f(req, 'skip') !== '0');
    return `line-${n}`;
  }));
  app.post('/runs/:id/lines/:n/arrived', { config: { access: 'user' } }, decide((req, id) => {
    const n = lineParam(req);
    setArrived(actions, id, kit.actorOf(req), n, f(req, 'arrived'), f(req, 'pieces'), f(req, 'pounds'));
    return `line-${n}`;
  }));
  app.post('/runs/:id/override', { config: { access: 'user' } }, decide((req, id) => {
    decideOverride(actions, id, kit.actorOf(req), { variationId: f(req, 'variationId'), choice: f(req, 'choice'), price: f(req, 'price'), shownFormulaCents: f(req, 'formulaCents'), shownOverrideCents: f(req, 'overrideCents') });
  }));
  app.post('/runs/:id/conflict', { config: { access: 'user' } }, decide((req, id) => {
    pickConflictPrice(actions, id, kit.actorOf(req), f(req, 'variationId'), f(req, 'priceCents'));
  }));
  app.post('/runs/:id/rename', { config: { access: 'user' } }, decide((req, id) => {
    renameItem(actions, id, kit.actorOf(req), f(req, 'itemId'), f(req, 'name'));
  }));
  // Cards. Each one is checked against this run's own card list and audited with the run id.
  const cardAnchor = (id: number, variationId: string): string => {
    const run = getRun(db, id);
    if (!run) return 'cards-h';
    const ev = evaluateRun(actions, run);
    const i = ev.cards.findIndex((c) => c.variationId === variationId);
    return i >= 0 ? `card-${i + 1}` : 'cards-h';
  };
  app.post('/runs/:id/cards/confirm', { config: { access: 'user' } }, decide((req, id) => {
    const v = variationField(f(req, 'variationId'));
    confirmCard(actions, id, kit.actorOf(req), v, numberField(f(req, 'cardId')));
    return cardAnchor(id, v);
  }));
  app.post('/runs/:id/cards/reject', { config: { access: 'user' } }, decide((req, id) => {
    const v = variationField(f(req, 'variationId'));
    rejectCard(actions, id, kit.actorOf(req), v, numberField(f(req, 'cardId')));
    return cardAnchor(id, v);
  }));
  app.post('/runs/:id/cards/edit', { config: { access: 'user' } }, decide((req, id) => {
    const v = variationField(f(req, 'variationId'));
    const input: CardEditInput = {
      origin: f(req, 'origin'),
      eyebrow: f(req, 'eyebrow'),
      n1: f(req, 'n1'),
      n2: f(req, 'n2'),
      producer: f(req, 'producer'),
      specs: [1, 2, 3].map((n) => [f(req, `spec${n}Label`), f(req, `spec${n}Value`)] as [string, string]),
      paragraphs: [1, 2, 3, 4].map((n) => f(req, `p${n}`)),
      unit: f(req, 'unit'),
    };
    editRunCard(actions, id, kit.actorOf(req), v, numberField(f(req, 'cardId')), numberField(f(req, 'version')), input);
    return cardAnchor(id, v);
  }));
  app.post('/runs/:id/cards/check', { config: { access: 'user' } }, decide((req, id) => {
    const v = variationField(f(req, 'variationId'));
    checkRunCard(actions, id, kit.actorOf(req), v, numberField(f(req, 'cardId')), numberField(f(req, 'version')), f(req, 'confirm') === '1');
    return cardAnchor(id, v);
  }));
  app.post('/runs/:id/cards/write', { config: { access: 'user' } }, decide((req, id) => {
    const all = f(req, 'all') === '1';
    writeCardCopy(actions, id, actorWithId(req), all ? 'all' : variationField(f(req, 'variationId')));
    return 'cards-h';
  }));
  app.post('/runs/:id/cards/leave-out', { config: { access: 'user' } }, decide((req, id) => {
    const v = variationField(f(req, 'variationId'));
    leaveCardOut(actions, id, kit.actorOf(req), v, f(req, 'leaveOut') !== '0');
    return cardAnchor(id, v);
  }));
  // Copy past its budget is the admin's call, for every waiting card at once, with a recent
  // password like other admin changes.
  app.post('/runs/:id/cards/approve-cost', { config: { access: 'admin' } }, decide((req, id) => {
    approveCardCosts(actions, id, actorWithId(req), { model: f(req, 'model'), totalUsd: f(req, 'totalUsd'), fingerprint: f(req, 'fingerprint') });
    return 'cards-h';
  }));
  app.post('/runs/:id/checks/accept', { config: { access: 'user' } }, decide((req, id) => {
    acceptCheck(actions, id, kit.actorOf(req), f(req, 'checkId'));
  }));
  app.post('/runs/:id/undo', { config: { access: 'user' } }, decide((req, id) => {
    undoDecision(actions, id, kit.actorOf(req), f(req, 'kind'), f(req, 'target'));
  }));
  app.post('/runs/:id/supplier', { config: { access: 'user' } }, decide((req, id) => {
    const raw = f(req, 'supplierId');
    if (f(req, 'create') === '1') chooseSupplier(actions, id, kit.actorOf(req), { create: true });
    else if (/^[1-9][0-9]{0,9}$/.test(raw)) chooseSupplier(actions, id, kit.actorOf(req), { supplierId: Number(raw) });
    else throw new RunError('Choose a supplier.', 400);
  }));
  app.post('/runs/:id/read-again', { config: { access: 'user' } }, decide((req, id) => {
    readAgain(actions, id, actorWithId(req));
  }));
  app.post('/runs/:id/stop', { config: { access: 'user' } }, decide((req, id) => {
    stopRun(actions, id, kit.actorOf(req));
  }));
  app.post('/runs/:id/dry-run', { config: { access: 'user' } }, decide((req, id) => {
    requestDryRun(actions, id, actorWithId(req));
  }));
  // Spending more than the cost cap is the admin's call, with a recent password like other admin changes.
  app.post('/runs/:id/approve-cost', { config: { access: 'admin' } }, decide((req, id) => {
    approveCost(actions, id, actorWithId(req), { model: f(req, 'model'), estimateUsd: f(req, 'estimateUsd') });
  }));
  if (svc.sheets) {
    // A refused sheet action shows the page it came from, with the reason.
    await registerSheetRoutes(app, kit, svc.sheets, (req, reply, runId, status, error) => {
      if (kit.field(req, 'from') === 'dry-run') {
        const run = mustGetRun(db, runId);
        const view = dryRunView(db, run, run.state === 'approved' ? [] : approvalProblems(actions, run, null));
        if (view) return kit.sendPage(reply, status, dryRunPage({ user: signedIn(req), view, error, sheets: sheetSection(db, run), mailchimp: mailchimpDryRunSection(getMailchimpPreview(db, run.id, run.dryRunHash)) }));
      }
      return showRun(req, reply, runId, status, error);
    });
  }

  app.post('/runs/:id/approve', { config: { access: 'user' } }, async (req, reply) => {
    const runId = kit.idParam(req);
    try {
      approveRun(actions, runId, actorWithId(req), f(req, 'hash'));
      return reply.redirect(`/runs/${runId}/dry-run`, 303);
    } catch (err) {
      if (!(err instanceof RunError)) throw err;
      const run = getRun(db, runId);
      if (!run) return kit.sendPage(reply, 404, errorPage(404, err.message, req.user));
      const view = dryRunView(db, run, approvalProblems(actions, run, null));
      if (!view) return showRun(req, reply, runId, err.status, err.message);
      return kit.sendPage(reply, err.status, dryRunPage({ user: signedIn(req), view, error: err.message }));
    }
  });
}
