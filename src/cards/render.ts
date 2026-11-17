// Renders card sheets with LibreOffice and poppler (pdfinfo, pdftotext, pdftoppm).
//
// LibreOffice handling, because staff use this PC:
// - It runs under nice -n 19, one conversion at a time across all processes,
//   guarded by a lock file that is taken atomically (a pid file is written in
//   full, then hard linked into place; the link fails if the lock exists).
// - Each run gets a fresh profile directory, removed afterwards, so a run
//   never hands its job to a LibreOffice window staff have open and a stuck
//   earlier run cannot block it.
// - soffice starts oosplash, which forks soffice.bin. The job runs in its own
//   process group, and on timeout (and after exit, to catch stragglers) the
//   whole group is killed, not just the first process. Ctrl-C or SIGTERM
//   to Node also kills the group and removes the profile.
// - A lock is cleared when its pid is not running or when it is older than
//   the conversion timeout plus a minute.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeXmlEntities } from './xml.ts';

/** Where per-run profiles and the lock live (data/ is not in git). */
export const DEFAULT_WORK_ROOT = fileURLToPath(new URL('../../data/cards', import.meta.url));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readPid = (path: string): number | null => {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

const lockStat = (path: string) => {
  try {
    return statSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/**
 * Moves a stale lock aside. Each lock is a new file, so if the file moved is
 * not the one judged stale (another process took the lock in between), it is
 * put back.
 */
function breakStaleLock(lockPath: string, staleIno: number): void {
  const aside = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (lockStat(aside)?.ino !== staleIno) {
    try {
      linkSync(aside, lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  rmSync(aside, { force: true });
}

/** A lock older than this is stale whatever its pid says: the conversion timeout plus a margin. */
export const DEFAULT_LOCK_STALE_MS = 180_000 + 60_000;

/**
 * Takes the lock, waiting up to waitMs for another conversion to finish.
 * A lock is stale, and cleared, when its pid is not running, or when it is
 * older than staleMs (covers a reused pid and a file with no valid pid).
 * Returns the release function.
 */
export async function acquireLock(
  lockPath: string,
  waitMs = 600_000,
  pollMs = 2_000,
  staleMs = DEFAULT_LOCK_STALE_MS,
): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const tmp = `${lockPath}.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, String(process.pid));
    try {
      linkSync(tmp, lockPath);
      return () => {
        if (readPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
    const st = lockStat(lockPath);
    const holder = readPid(lockPath);
    if (st === null || holder === null) continue; // released in between
    const deadHolder = Number.isInteger(holder) && holder > 0 && !alive(holder);
    if (deadHolder || Date.now() - st.mtimeMs > staleMs) {
      breakStaleLock(lockPath, st.ino);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Another LibreOffice conversion holds ${lockPath} (pid ${holder}). Run one at a time.`);
    }
    await sleep(pollMs);
  }
}

const killGroup = (pid: number | undefined): void => {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
};

export interface ConvertOptions {
  timeoutMs?: number;
  /** Directory for the lock and the per-run profile. */
  workRoot?: string;
  /** How long to wait for another conversion. */
  lockWaitMs?: number;
  /** Replaces the soffice command line. For tests only. */
  command?: string[];
}

/** Converts a .docx to PDF in outDir and returns the PDF path. */
export async function docxToPdf(docxPath: string, outDir: string, opts: ConvertOptions = {}): Promise<string> {
  const workRoot = opts.workRoot ?? DEFAULT_WORK_ROOT;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  const pdf = join(outDir, basename(docxPath, extname(docxPath)) + '.pdf');
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const release = await acquireLock(join(workRoot, '.soffice.lock'), opts.lockWaitMs, undefined, timeoutMs + 60_000);
  const profile = mkdtempSync(join(workRoot, '.lo-profile-'));
  let childPid: number | undefined;
  // soffice runs in its own process group, so Ctrl-C does not reach it. On
  // SIGINT or SIGTERM, kill the group, remove the profile, release the lock,
  // then let the signal take its normal course.
  const onSignal = (sig: NodeJS.Signals) => {
    killGroup(childPid);
    rmSync(profile, { recursive: true, force: true });
    release();
    removeHandlers();
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  };
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((sig) => [sig, () => onSignal(sig)] as const);
  const removeHandlers = () => {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  };
  for (const [sig, h] of handlers) process.once(sig, h);
  try {
    rmSync(pdf, { force: true });
    await new Promise<void>((resolveRun, rejectRun) => {
      const [cmd, ...args] = opts.command ?? [
        'nice', '-n', '19', 'soffice', '--headless', '--norestore', '--nologo', '--nodefault',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to', 'pdf', '--outdir', outDir, docxPath,
      ];
      const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      childPid = child.pid;
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        rejectRun(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        killGroup(child.pid); // anything left in the group, such as soffice.bin
        if (timedOut) rejectRun(new Error(`LibreOffice timed out converting ${docxPath}; its process group was killed`));
        else if (code !== 0) rejectRun(new Error(`LibreOffice exited ${code} converting ${docxPath}: ${stderr.trim()}`));
        else resolveRun();
      });
    });
  } finally {
    removeHandlers();
    rmSync(profile, { recursive: true, force: true });
    release();
  }
  if (!existsSync(pdf)) throw new Error(`LibreOffice did not write ${pdf}`);
  return pdf;
}

// The poppler calls come in two forms. The plain ones block, for scripts. The Async ones run the
// program in a child process without blocking, under nice 19, for the server, so a check never
// stalls a request.
const run = promisify(execFile);
const POPPLER_MAX = 256 * 1024 * 1024;

async function poppler(args: string[]): Promise<string> {
  const { stdout } = await run('nice', ['-n', '19', ...args], { encoding: 'utf8', maxBuffer: POPPLER_MAX });
  return stdout;
}

function pageCountOf(info: string, pdf: string): number {
  const m = /^Pages:\s+(\d+)/m.exec(info);
  if (!m) throw new Error(`pdfinfo gave no page count for ${pdf}`);
  return Number(m[1]);
}

function fontsOf(out: string): string[] {
  return out
    .split('\n')
    .slice(2)
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean)
    .map((n) => n.replace(/^[A-Z]{6}\+/, ''));
}

export async function pdfPageCountAsync(pdf: string): Promise<number> {
  return pageCountOf(await poppler(['pdfinfo', pdf]), pdf);
}

export async function pdfPageTextAsync(pdf: string, page: number): Promise<string> {
  return poppler(['pdftotext', '-f', String(page), '-l', String(page), '-enc', 'UTF-8', pdf, '-']);
}

export async function pdfFontsAsync(pdf: string): Promise<string[]> {
  return fontsOf(await poppler(['pdffonts', pdf]));
}

export async function pdfWordsAsync(pdf: string): Promise<PageWords[]> {
  return parseBboxHtml(await poppler(['pdftotext', '-bbox', '-enc', 'UTF-8', pdf, '-']));
}

export function pdfPageCount(pdf: string): number {
  return pageCountOf(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }), pdf);
}

export function pdfPageText(pdf: string, page: number): string {
  return execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-enc', 'UTF-8', pdf, '-'], { encoding: 'utf8' });
}

/** Fonts embedded in the PDF, to confirm the real fonts were used and not a fallback. */
export function pdfFonts(pdf: string): string[] {
  return fontsOf(execFileSync('pdffonts', [pdf], { encoding: 'utf8' }));
}

/** Writes page `page` as PNG to `<outPrefix>.png` and returns the path. */
export function pdfPageToPng(pdf: string, page: number, outPrefix: string, dpi = 110): string {
  execFileSync('nice', ['-n', '19', 'pdftoppm', '-f', String(page), '-l', String(page), '-r', String(dpi), '-png', '-singlefile', pdf, outPrefix]);
  return `${outPrefix}.png`;
}

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes a pixel. */
  data: Buffer;
}

/** Renders one page to raw RGB through pdftoppm's PPM output. */
export function pdfPageRaster(pdf: string, page: number, dpi = 110): Raster {
  const ppm = execFileSync('nice', ['-n', '19', 'pdftoppm', '-f', String(page), '-l', String(page), '-r', String(dpi), '-singlefile', pdf], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(ppm.subarray(0, 64).toString('latin1'));
  if (!header || header[3] !== '255') throw new Error('Unexpected PPM from pdftoppm');
  const offset = header[0].length;
  return { width: Number(header[1]), height: Number(header[2]), data: ppm.subarray(offset) };
}

/** Counts pixels whose colour differs between two rasters of the same size. */
export function rasterDiff(a: Raster, b: Raster): { differing: number; total: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Raster sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differing++;
  }
  return { differing, total: a.width * a.height };
}

export interface WordBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

export interface PageWords {
  width: number;
  height: number;
  words: WordBox[];
}

/** Parses pdftotext -bbox output. Exported for tests. */
export function parseBboxHtml(html: string): PageWords[] {
  return html
    .split('<page ')
    .slice(1)
    .map((ph) => ({
      width: Number(/width="([\d.]+)"/.exec(ph)?.[1]),
      height: Number(/height="([\d.]+)"/.exec(ph)?.[1]),
      words: [...ph.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
        x0: Number(m[1]),
        y0: Number(m[2]),
        x1: Number(m[3]),
        y1: Number(m[4]),
        text: decodeXmlEntities(m[5]),
      })),
    }));
}

/** Every word on every page with its box, in points, from pdftotext -bbox. */
export function pdfWords(pdf: string): PageWords[] {
  return parseBboxHtml(execFileSync('pdftotext', ['-bbox', '-enc', 'UTF-8', pdf, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
}

/**
 * Splits a page's words among its four cards by layout. The columns meet at
 * the page centre. In each column the first line belongs to the top card,
 * and its leftmost word is that card's header word. The bottom card starts
 * at the next word that looks the same and sits in the same place: same
 * text, same left edge, same box height (so same font and size), first on
 * its line, and at least minPitchPt below (the sum of the minimum row
 * heights plus the gutter). A word in the copy or name never matches,
 * because those are set in another size or font even when the text is the
 * same. Returns slots 1 to 4 in order.
 */
export function wordsByCard(page: PageWords, minPitchPt: number): WordBox[][] {
  const mid = page.width / 2;
  const out: WordBox[][] = [[], [], [], []];
  for (const c of [0, 1]) {
    const ws = page.words.filter((w) => (w.x0 < mid ? 0 : 1) === c);
    if (ws.length === 0) continue;
    const lines = textLines(ws);
    const first = lines[0][0];
    const h = first.y1 - first.y0;
    const start = lines
      .map((l) => l[0])
      .find(
        (w) =>
          w.y0 >= first.y0 + minPitchPt - 1 &&
          w.text === first.text &&
          Math.abs(w.x0 - first.x0) < 1 &&
          Math.abs(w.y1 - w.y0 - h) < 0.3,
      );
    const split = start ? start.y0 - 1 : Infinity;
    for (const w of ws) out[(w.y0 >= split ? 2 : 0) + c].push(w);
  }
  return out;
}

/** The least distance from one card's top to the card below it, in points. */
export function minCardPitchPt(rowHeights: number[], gutter: number): number {
  return (rowHeights.reduce((a, b) => a + b, 0) + gutter) / 20;
}

/** Groups word boxes into text lines by vertical centre, top to bottom. */
export function textLines(words: WordBox[]): WordBox[][] {
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines: WordBox[][] = [];
  for (const w of sorted) {
    const c = (w.y0 + w.y1) / 2;
    const line = lines[lines.length - 1];
    if (line) {
      const lc = line.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / line.length;
      const h = Math.max(...line.map((x) => x.y1 - x.y0), w.y1 - w.y0);
      if (Math.abs(c - lc) < h * 0.3) {
        line.push(w);
        continue;
      }
    }
    lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0));
}
