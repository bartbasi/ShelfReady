// The background check for card sheets (src/runs/card-sheets.ts): one sheet at a time, never in
// a request. It renders the stored file with LibreOffice (src/cards/render.ts: nice -n 19, one
// conversion at a time across every process, behind the shared lock) and runs the cards checks
// (src/cards/verify.ts) on the cards read back from the file itself.
//
// Outcomes:
// - passed: the page count is right and every card is whole.
// - failed: a real failure, which blocks the download. The page count is wrong, or a card's text
//   is cut off: the end of its copy is missing, the copy runs past the panel's lines, or words of
//   the card are missing from its page. Each failing card is named.
// - unchecked: the check could not run (LibreOffice or poppler missing, the real fonts missing, a
//   crash or a timeout). The file is offered with that warning, and a person can ask again.
//
// It runs apart from the invoice job runner, so a check never waits behind a send or holds one
// up. Sheets are rows in card_sheets, so a check cut short by a restart simply runs again.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseCardsDocx } from '../cards/import.ts';
import { DEFAULT_WORK_ROOT, docxToPdf, pdfFontsAsync } from '../cards/render.ts';
import type { CardConfig, CardRecord } from '../cards/types.ts';
import { checkSheetPdfAsync, type SheetCheck } from '../cards/verify.ts';
import { SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import { claimNextCheck, queuedChecks, recordCheck, requeueInterrupted, type CardFailure, type SheetCheckResult } from './card-sheets.ts';
import { readStoredFile } from './files.ts';

export interface SheetCheckOutcome {
  state: 'passed' | 'failed' | 'unchecked';
  result: SheetCheckResult | null;
  message: string;
}

/** Checks one sheet file. The slots are the cards read back from it, null for blank padding. */
export type SheetCheckFn = (docx: Buffer, slots: Array<CardRecord | null>, cfg: CardConfig) => Promise<SheetCheckOutcome>;

const TOOLS = ['soffice', 'pdfinfo', 'pdftotext', 'pdffonts'] as const;

const run = promisify(execFile);

/** The programs the check needs that are not installed. Empty when all are. Never blocks. */
export async function missingTools(): Promise<string[]> {
  const found = await Promise.all(
    TOOLS.map((t) =>
      run('sh', ['-c', 'command -v "$1"', 'sh', t]).then(
        () => true,
        () => false,
      ),
    ),
  );
  return TOOLS.filter((_, i) => !found[i]);
}

/** Turns the raw checks into plain words, naming each failing card. Exported for tests. */
export function judge(r: SheetCheck, missingFonts: string[]): SheetCheckOutcome {
  const failures: CardFailure[] = [];
  const clipped = (c: (typeof r.cards)[number]) => c.missingTail.length > 0 || c.copyLines > c.maxCopyLines;
  // The full text check counts words per page, so a word a clipped card lost is short for every
  // card that uses it. Those words are put down to the clipped card, not its neighbours.
  const explained = new Map<number, Set<string>>();
  for (const c of r.cards) if (clipped(c)) explained.set(c.page, new Set([...(explained.get(c.page) ?? []), ...c.shortWords]));
  for (const c of r.cards) {
    const problems: string[] = [];
    if (c.missingTail.length) problems.push(`The end of the copy is cut off (missing: ${c.missingTail.join(' ')}).`);
    if (c.copyLines > c.maxCopyLines) problems.push(`The copy runs ${c.copyLines} lines. The panel holds ${c.maxCopyLines}.`);
    const short = clipped(c) ? c.shortWords : c.shortWords.filter((w) => !explained.get(c.page)?.has(w));
    if (short.length) problems.push(`Words missing from the page: ${short.slice(0, 8).join(' ')}.`);
    if (problems.length) failures.push({ page: c.page, slot: c.slot, name: c.name, problems });
  }
  const result: SheetCheckResult = {
    pages: r.pages,
    expectedPages: r.expectedPages,
    pageCountOk: r.pageCountOk,
    failures,
    mostCopyLines: Math.max(0, ...r.cards.map((c) => c.copyLines)),
    maxCopyLines: Math.max(0, ...r.cards.map((c) => c.maxCopyLines)),
    missingFonts,
  };
  if (missingFonts.length) {
    return {
      state: 'unchecked',
      result,
      message: `The real fonts (${missingFonts.join(' and ')}) are not installed on this PC, so the check cannot be trusted. Look over the printed pages before cutting. See docs/INSTALL.md, Fonts for the card check.`,
    };
  }
  const parts: string[] = [];
  if (!r.pageCountOk) parts.push(`The sheet came out at ${r.pages} ${r.pages === 1 ? 'page' : 'pages'}, not ${r.expectedPages}. Something spills past its page.`);
  if (failures.length) parts.push(`Cut off: ${failures.map((f) => f.name || `page ${f.page} card ${f.slot}`).join(', ')}. Shorten ${failures.length === 1 ? 'that card' : 'those cards'} and make a reprint.`);
  if (parts.length) return { state: 'failed', result, message: parts.join(' ') };
  return { state: 'passed', result, message: `${r.pages} ${r.pages === 1 ? 'page' : 'pages'} as expected. Every card is whole. Most copy lines: ${result.mostCopyLines} of ${result.maxCopyLines}.` };
}

/** The real check: LibreOffice and poppler, under nice 19, one conversion at a time. */
export function renderSheetCheck(workRoot: string = DEFAULT_WORK_ROOT): SheetCheckFn {
  return async (docx, slots, cfg) => {
    const missing = await missingTools();
    if (missing.length) {
      const lo = missing.includes('soffice');
      return {
        state: 'unchecked',
        result: null,
        message: `${lo ? 'LibreOffice is' : `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'}`} not installed on this PC, so the sheet was not checked. Look over the printed pages before cutting.`,
      };
    }
    mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(workRoot, 'sheet-check-'));
    try {
      const file = join(dir, 'sheet.docx');
      writeFileSync(file, docx, { mode: 0o600 });
      let pdf: string;
      try {
        pdf = await docxToPdf(file, dir, { workRoot });
      } catch {
        return { state: 'unchecked', result: null, message: 'LibreOffice could not render the sheet (it stopped, timed out, or another conversion held it too long). Press Check again.' };
      }
      const fonts = (await pdfFontsAsync(pdf)).map((f) => f.replace(/\s/g, ''));
      const missingFonts = [cfg.fonts.display, cfg.fonts.body].filter((f) => !fonts.some((n) => n.startsWith(f.replace(/\s/g, ''))));
      return judge(await checkSheetPdfAsync(pdf, slots, cfg), missingFonts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export interface SheetCheckerDeps {
  db: Db;
  dir: string;
  cardConfig: () => CardConfig;
  check: SheetCheckFn;
  now: () => number;
  log: { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** Start as soon as a sheet is queued. Default true. Tests turn it off and call drain. */
  auto?: boolean;
}

export interface SheetChecker {
  kick(): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
  /** Puts checks a restart cut short back in the queue. Called once at start. */
  recover(): void;
}

export function createSheetChecker(deps: SheetCheckerDeps): SheetChecker {
  const { db, now, log } = deps;
  let current: Promise<void> | null = null;
  let stopped = false;

  async function checkOne(): Promise<boolean> {
    const sheet = claimNextCheck(db, now());
    if (!sheet) return false;
    log.info({ runId: sheet.runId, sheet: sheet.id }, 'card sheet check started');
    let outcome: SheetCheckOutcome;
    try {
      const buf = readStoredFile(deps.dir, sheet.storedName);
      if (createHash('sha256').update(buf).digest('hex') !== sheet.sha256) {
        outcome = { state: 'failed', result: null, message: 'The file changed after it was made. Make a reprint, and tell Bart.' };
      } else {
        const { slots } = parseCardsDocx(buf);
        outcome = await deps.check(buf, slots, deps.cardConfig());
      }
    } catch (err) {
      log.error({ runId: sheet.runId, sheet: sheet.id, err: err instanceof Error ? err.name : 'unknown' }, 'card sheet check failed to run');
      outcome = { state: 'unchecked', result: null, message: 'The check could not run. Press Check again. If it keeps happening, tell Bart.' };
    }
    try {
      recordCheck(db, SYSTEM_ACTOR, sheet, outcome, now());
    } catch (err) {
      log.error({ runId: sheet.runId, sheet: sheet.id, err: err instanceof Error ? err.name : 'unknown' }, 'could not record a card sheet check');
      return false;
    }
    log.info({ runId: sheet.runId, sheet: sheet.id, state: outcome.state }, 'card sheet check done');
    return true;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      let more: boolean;
      try {
        more = await checkOne();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'card sheet checker error');
        return;
      }
      if (!more) return;
    }
  }

  const start = (): void => {
    if (current || stopped) return;
    current = loop().finally(() => {
      current = null;
    });
  };

  return {
    kick() {
      if (deps.auto !== false) start();
    },
    async drain() {
      while (!stopped) {
        start();
        if (current) await current;
        if (queuedChecks(db) === 0) return;
      }
    },
    async stop() {
      stopped = true;
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
    recover() {
      requeueInterrupted(db, now());
    },
  };
}
