// The confirmed matches of fish email rows to Square items. Store data: the file lives in data/
// (out of git), by default data/mailchimp/fish-matches.json (config matchesFile).
//
// Another script proposes matches and Bart confirms them; this module defines the file both use.
// The format, version 1:
//
//   {
//     "version": 1,
//     "rows": [
//       { "row": "Striped Bass (Farmed)", "status": "confirmed", "itemId": "SQUAREITEMID",
//         "confirmedBy": "Bart", "confirmedAt": "2026-11-10" },
//       { "row": "Littlenecks", "status": "proposed", "itemId": "SQUAREITEMID" },
//       { "row": "Live Lobster, 4+ lb (Special order)", "status": "none", "note": "special order only" }
//     ]
//   }
//
// - row: the email row's key, the name and the bracket text as a reader sees them (src/mailchimp/
//   html.ts rowKey). Compared without regard to case, curly quotes or spacing. Each row once.
// - status: confirmed (Bart said yes: ShelfReady may change this row's price), proposed (waiting
//   for Bart: never used), none (Bart said it has no Square item: never changed, not asked again).
// - itemId: the Square item. variationId, optional: pins one variation when the item has several.
// - confirmedBy, confirmedAt, note: for people; kept as they are.
//
// Only confirmed rows are ever changed. A row with no confirmed match is listed in review.

import { existsSync } from 'node:fs';
import { readFileUnder, SafeFileError } from '../server/safe-file.ts';
import { foldKey } from './html.ts';

export type MatchStatus = 'confirmed' | 'proposed' | 'none';

export interface FishMatch {
  row: string;
  status: MatchStatus;
  itemId: string | null;
  variationId: string | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string;
}

export interface FishMatches {
  version: 1;
  rows: FishMatch[];
}

const SQUARE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_ROWS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

export class MatchesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchesError';
  }
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}

/** Checks a parsed matches file. Throws MatchesError with a plain message. */
export function checkMatches(raw: unknown): FishMatches {
  const f = raw as Record<string, unknown>;
  if (!f || typeof f !== 'object' || f.version !== 1 || !Array.isArray(f.rows)) throw new MatchesError('The fish matches file is not version 1 with a list of rows.');
  if (f.rows.length > MAX_ROWS) throw new MatchesError(`The fish matches file has more than ${MAX_ROWS} rows.`);
  const seen = new Set<string>();
  const rows = (f.rows as Array<Record<string, unknown>>).map((r, i) => {
    const row = text(r?.row, 300).trim();
    if (!row) throw new MatchesError(`Fish match ${i + 1} has no row name.`);
    const k = foldKey(row);
    if (seen.has(k)) throw new MatchesError(`The fish matches file lists "${row}" twice.`);
    seen.add(k);
    const status = r.status;
    if (status !== 'confirmed' && status !== 'proposed' && status !== 'none') throw new MatchesError(`Fish match "${row}": status must be confirmed, proposed or none.`);
    const itemId = r.itemId === undefined || r.itemId === null || r.itemId === '' ? null : String(r.itemId);
    const variationId = r.variationId === undefined || r.variationId === null || r.variationId === '' ? null : String(r.variationId);
    if (itemId !== null && !SQUARE_ID.test(itemId)) throw new MatchesError(`Fish match "${row}": itemId is not a Square id.`);
    if (variationId !== null && !SQUARE_ID.test(variationId)) throw new MatchesError(`Fish match "${row}": variationId is not a Square id.`);
    if (status === 'confirmed' && itemId === null) throw new MatchesError(`Fish match "${row}" is confirmed but names no Square item.`);
    if (status === 'none' && (itemId !== null || variationId !== null)) throw new MatchesError(`Fish match "${row}" says none but names a Square item.`);
    return { row, status, itemId, variationId, confirmedBy: text(r.confirmedBy, 100), confirmedAt: text(r.confirmedAt, 40), note: text(r.note, 300) } as FishMatch;
  });
  return { version: 1, rows };
}

/**
 * Reads the matches file, which must sit inside dataDir. A missing file means no matches yet
 * (nothing is changed). A file that is there but cannot be used throws.
 */
export function loadMatches(path: string, dataDir: string): FishMatches {
  if (!existsSync(path)) return { version: 1, rows: [] };
  let bytes: Buffer;
  try {
    bytes = readFileUnder(path, [dataDir], { min: 2, max: MAX_BYTES }).bytes;
  } catch (err) {
    if (err instanceof SafeFileError && err.problem === 'outside') throw new MatchesError('The fish matches file must be inside the data folder.');
    throw new MatchesError('The fish matches file cannot be read.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new MatchesError('The fish matches file is not valid JSON.');
  }
  return checkMatches(raw);
}
