// Routes for old invoices (purchase history). Record only: nothing here reaches Square, the scales
// or the cards, and nothing makes an invoice run.
//
// Every route declares its access level; app.ts checks it in onRequest, before any body is read.
// Signed-in managers and admins may list, upload, view and download. Removing an old invoice is
// admin only, needs a recent password like every admin change, and is audited.
//
// The upload copies the invoice run upload (src/server/run-routes.ts): multipart is registered for
// it alone, its size is checked from Content-Length before anything is read, its CSRF token must be
// the first part, and the per-person rate, daily byte limits, free space and upload slots apply.

import { createHash } from 'node:crypto';
import { closeSync, writeSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { tokensEqual } from '../auth/csrf.ts';
import { exportFileName, purchaseCsv, purchaseXlsx } from '../history/export.ts';
import {
  attemptsSince,
  createPurchaseInvoice,
  exportRows,
  getPurchaseInvoice,
  HistoryError,
  listPurchaseInvoices,
  purchaseFiles,
  purchaseLines,
  recordAttempt,
  removePurchaseInvoice,
  runCopyOf,
  storedBytesSince,
  type NewFile,
} from '../history/store.ts';
import type { HistoryWorker } from '../history/worker.ts';
import { estimatePdfPages, sniffUpload, type UploadKind } from '../invoice/images.ts';
import type { UploadLimits } from '../invoice/settings.ts';
import { displayName, ensureUploadDir, freeBytes, newStoredName, openNewFile, readStoredFile, removeStoredFile, UploadDirError } from '../runs/files.ts';
import type { ServerConfig } from './config.ts';
import type { AuditActor } from '../db/audit.ts';
import { errorPage } from './views/pages.ts';
import type { UploadSlots } from './upload-slots.ts';
import { historyInvoicePage, historyListPage, historyUploadPage } from './views/history-pages.ts';

/** What app.ts lends these routes: the same helpers the run routes get. */
export interface HistoryKit {
  sendPage(reply: FastifyReply, status: number, body: string): FastifyReply;
  field(req: FastifyRequest, name: string): string;
  idParam(req: FastifyRequest): number;
  actorOf(req: FastifyRequest): AuditActor;
  now(): number;
}

export interface HistoryServices {
  config: ServerConfig;
  worker: HistoryWorker;
  /** Where old invoice files are kept. */
  dir: string;
  uploadLimits: UploadLimits;
  /** Upload slots shared with invoice runs. */
  uploadSlots: UploadSlots;
}

class UploadRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Most lines in one download. */
export const MAX_EXPORT_ROWS = 20_000;

const CONTENT_TYPES: Record<UploadKind, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heif', pdf: 'application/pdf' };

function fileParam(req: FastifyRequest): number | null {
  const raw = (req.params as { fileId?: string }).fileId ?? '';
  return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}

/** A date from the download form: YYYY-MM-DD and a real day, or '' when left empty. */
export function dateQuery(raw: unknown): string | null {
  if (raw === undefined || raw === '') return '';
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? raw : null;
}

export async function registerHistoryRoutes(app: FastifyInstance, kit: HistoryKit, svc: HistoryServices): Promise<void> {
  const db = app.shelf.db;
  const limits = svc.uploadLimits;
  const signedIn = (req: FastifyRequest) => req.user!;
  const mb = Math.round(limits.maxFileBytes / (1024 * 1024));

  const listPage = (req: FastifyRequest, reply: FastifyReply, status = 200, error?: string, range: { from?: string; to?: string } = {}) =>
    kit.sendPage(reply, status, historyListPage({ user: signedIn(req), invoices: listPurchaseInvoices(db), error, ...range }));

  app.get('/history', { config: { access: 'user' } }, async (req, reply) => listPage(req, reply));

  app.get('/history/new', { config: { access: 'user' } }, async (req, reply) =>
    kit.sendPage(reply, 200, historyUploadPage({ user: signedIn(req), maxFiles: limits.maxFiles, maxFileMb: mb, maxPdfPages: limits.maxPdfPages })),
  );

  // The downloads. Only recorded invoices, in the date range asked for.
  const download = (ext: 'xlsx' | 'csv') => async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const from = dateQuery(q.from);
    const to = dateQuery(q.to);
    if (from === null || to === null) return listPage(req, reply, 400, 'Pick the dates from the calendar, or leave them empty.');
    if (from && to && from > to) return listPage(req, reply, 400, 'The from date is after the to date.', { from, to });
    const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    // A row cap keeps one download from holding the server for long.
    const rows = exportRows(db, range, MAX_EXPORT_ROWS + 1);
    if (rows.length > MAX_EXPORT_ROWS) {
      return listPage(req, reply, 400, `That is more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} lines. Pick a shorter date range.`, range);
    }
    // The .xlsx adds one tab per vendor, from these same rows; the dates go in each tab's note.
    const body = ext === 'xlsx' ? Buffer.from(purchaseXlsx(rows, range)) : purchaseCsv(rows);
    reply.header('Content-Disposition', `attachment; filename="${exportFileName(range, ext)}"`);
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.type(ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8').send(body);
  };
  app.get('/history/download.xlsx', { config: { access: 'user' } }, download('xlsx'));
  app.get('/history/download.csv', { config: { access: 'user' } }, download('csv'));


  const uploadError = (req: FastifyRequest, reply: FastifyReply, status: number, message: string): FastifyReply => {
    // The rest of a refused body is not read.
    reply.header('Connection', 'close');
    return kit.sendPage(reply, status, historyUploadPage({ user: signedIn(req), maxFiles: limits.maxFiles, maxFileMb: mb, maxPdfPages: limits.maxPdfPages, error: message }));
  };

  // The upload, in its own scope so multipart is parsed here and nowhere else.
  await app.register(async (scope) => {
    await scope.register(fastifyMultipart, {
      limits: { files: limits.maxFiles, fileSize: limits.maxFileBytes, fields: 4, fieldSize: 256, fieldNameSize: 32, parts: limits.maxFiles * 2 + 4, headerPairs: 20 },
      throwFileSizeLimit: true,
    });

    scope.post(
      '/history',
      {
        config: { access: 'user', multipartCsrf: true },
        // After the access check, before anything is read: the attempt is counted, then the
        // rate, the size, the daily byte limits, free space, and an upload slot.
        onRequest: async (req, reply) => {
          if (!req.user) return;
          const u = svc.config.uploads;
          const userId = req.user.userId;
          if (attemptsSince(db, userId, kit.now() - 3600_000) >= u.historyPerUserPerHour) {
            return uploadError(req, reply, 429, 'You have tried a lot of uploads in the last hour. Wait a while and try again.');
          }
          recordAttempt(db, userId, kit.now());
          const len = req.headers['content-length'];
          if (len === undefined) return uploadError(req, reply, 411, 'The upload did not say how large it is. Try again from the upload page.');
          if (!/^\d{1,12}$/.test(len) || Number(len) > u.maxTotalBytes) {
            return uploadError(req, reply, 413, `That upload is too large. The limit is ${Math.round(u.maxTotalBytes / (1024 * 1024))} MB in all.`);
          }
          const dayAgo = kit.now() - 24 * 3600_000;
          if (storedBytesSince(db, dayAgo, userId) + Number(len) > u.maxBytesPerUserPerDay) {
            return uploadError(req, reply, 429, 'Your uploads today have reached your daily share. Try again tomorrow, or ask Bart.');
          }
          if (storedBytesSince(db, dayAgo) + Number(len) > u.maxBytesPerDay) {
            return uploadError(req, reply, 429, 'Uploads today have reached the daily limit. Try again tomorrow, or ask Bart.');
          }
          try {
            ensureUploadDir(svc.dir);
            if (freeBytes(svc.dir) < u.minFreeBytes + Number(len)) return uploadError(req, reply, 507, 'The disk is nearly full, so the upload was refused. Tell Bart.');
          } catch (err) {
            if (err instanceof UploadDirError) return uploadError(req, reply, 500, err.message);
            throw err;
          }
          // One set of slots for both upload routes, held until the response ends or the connection closes.
          const release = svc.uploadSlots.take(userId, u);
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
            req.log.warn({ path: '/history', user: signedIn(req).username }, 'refused an upload with a bad csrf token');
            reply.header('Connection', 'close');
            return kit.sendPage(reply, 403, errorPage(403, 'That form has expired. Reload the page and try again.', req.user));
          }
          (req as unknown as { shelfParts: typeof parts }).shelfParts = parts;
        },
      },
      async (req, reply) => {
        const parts = (req as unknown as { shelfParts: AsyncIterableIterator<any> }).shelfParts;
        const dir = svc.dir;
        const saved: NewFile[] = [];
        let total = 0;
        try {
          for await (const part of parts) {
            if (part.type !== 'file' || part.fieldname !== 'files') throw new UploadRefused(400, 'That form was not filled in as expected.');
            const storedName = newStoredName();
            const fd = openNewFile(dir, storedName);
            const hash = createHash('sha256');
            let head = Buffer.alloc(0);
            let bytes = 0;
            let kind: UploadKind | null = null;
            const entry: NewFile = { storedName, originalName: '', kind: 'jpeg', bytes: 0, sha256: '' };
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
          if (e.code === 'FST_REQ_FILE_TOO_LARGE') return uploadError(req, reply, 413, `A file is larger than ${mb} MB.`);
          if (e.code === 'FST_FILES_LIMIT') return uploadError(req, reply, 413, `At most ${limits.maxFiles} files can be read at once.`);
          if (e.code === 'FST_PARTS_LIMIT' || e.code === 'FST_FIELDS_LIMIT') return uploadError(req, reply, 413, 'That form has too many parts.');
          if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) return uploadError(req, reply, 400, 'The upload could not be read. Try again.');
          throw err;
        }
        let id: number;
        try {
          id = createPurchaseInvoice(db, { ...kit.actorOf(req), userId: signedIn(req).userId }, saved, kit.now(), svc.config.uploads.historyPerUserPerHour);
        } catch (err) {
          for (const f of saved) removeStoredFile(dir, f.storedName);
          if (err instanceof HistoryError) return uploadError(req, reply, err.status, err.message);
          throw err;
        }
        svc.worker.kick();
        return reply.redirect(`/history/${id}`, 303);
      },
    );
  });

  app.get('/history/:id', { config: { access: 'user' } }, async (req, reply) => {
    const id = kit.idParam(req);
    const inv = getPurchaseInvoice(db, id);
    if (!inv) return kit.sendPage(reply, 404, errorPage(404, 'There is no such old invoice.', req.user));
    // A run's lines are shown on the run's own page.
    if (inv.source === 'run') return reply.redirect(`/runs/${inv.runId}`, 303);
    return kit.sendPage(reply, 200, historyInvoicePage({ user: signedIn(req), inv, lines: purchaseLines(db, id), files: purchaseFiles(db, id), runCopy: runCopyOf(db, inv) }));
  });

  // A kept photo or PDF, for signed-in users only. Photos show inline; PDF and HEIF download.
  // The stored name is looked up by id, never taken from the request.
  app.get('/history/:id/files/:fileId', { config: { access: 'user' } }, async (req, reply) => {
    const id = kit.idParam(req);
    const fileId = fileParam(req);
    const f = fileId === null ? undefined : purchaseFiles(db, id).find((x) => x.id === fileId);
    if (!f) return kit.sendPage(reply, 404, errorPage(404, 'There is no such file.', req.user));
    const inline = f.kind === 'jpeg' || f.kind === 'png' || f.kind === 'webp';
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="old-invoice-${id}-${f.position}.${f.kind === 'jpeg' ? 'jpg' : f.kind}"`);
    return reply.type(CONTENT_TYPES[f.kind]).send(readStoredFile(svc.dir, f.storedName));
  });

  // Admin only, for a wrong upload. app.ts asks for a recent password first. Audited.
  app.post('/history/:id/remove', { config: { access: 'admin' } }, async (req, reply) => {
    const id = kit.idParam(req);
    const inv = getPurchaseInvoice(db, id);
    if (!inv) return kit.sendPage(reply, 404, errorPage(404, 'There is no such old invoice.', req.user));
    const again = (status: number, error: string) =>
      kit.sendPage(reply, status, historyInvoicePage({ user: signedIn(req), inv, lines: purchaseLines(db, id), files: purchaseFiles(db, id), error, runCopy: runCopyOf(db, inv) }));
    if (kit.field(req, 'confirm') !== '1') return again(400, 'Tick the box to confirm, then press Remove again.');
    let names: string[];
    try {
      names = removePurchaseInvoice(db, kit.actorOf(req), id, kit.now());
    } catch (err) {
      if (err instanceof HistoryError) return again(err.status, err.message);
      throw err;
    }
    for (const n of names) removeStoredFile(svc.dir, n);
    return reply.redirect('/history', 303);
  });
}
