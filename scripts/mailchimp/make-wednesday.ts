// One-off, asked for by Bart on November 10, 2026: make Wednesday's fish email by copying Monday's
// sent one, make the corrections he approved (store/docs/DECISIONS.md, Fish prices in Mailchimp), and
// schedule it for Wednesday, November 11, 2026 at 8:00am Chicago.
//
//   node scripts/mailchimp/make-wednesday.ts            dry run: reads only, does the edit locally
//   node scripts/mailchimp/make-wednesday.ts --apply    copies, edits, names and schedules it
//
// The corrections, all in one PUT of the HTML:
// - the row "Bart's Lobster Stock (8 oz (1 cup))" comes off (it is out, no date for more), with
//   the divider of the row that becomes last in its section (src/mailchimp/html.ts removeRow);
// - seven prices: five set to Square's, first update only (the three live lobster sizes and the
//   Lump and Jumbo crab cans), and two set to the scales' price (Bigeye Tuna and Cod from
//   Iceland), both approved by Bart. Each is checked against the price the email
//   shows now, and stops if it differs;
// - the date line at the top, "Wednesday, November 11, 2026".
// Then the title "Fish Email 20261111". The subject line and everything else stay as they are.
//
// Safety, as in scripts/mailchimp/remove-row.ts, on top of src/mailchimp/client.ts:
// - every request passes this script's own allowlist, per phase, on the method and exact path:
//   looking, reads only; copying, POST replicate on the source id only, plus reads; writing, for
//   the new copy only: read it, read its content, PUT its content, PATCH its title (settings only),
//   POST schedule. Nothing else, ever: no unschedule, no send, no delete, no other campaign.
// - the source must be the last sent fish email, and its id must be the one Bart named (kept out
//   of git, in config/local/mailchimp.json as campaigns.makeWednesdaySource). No draft
//   or scheduled fish email may exist after it already. Nothing is done inside the 60-minute
//   cutoff (from 7:00am Wednesday).
// - the edited HTML must equal the source with exactly those cuts, those seven prices and the date
//   line, byte for byte, before anything is sent; and again when read back.
// - a lost answer to the copy is looked for, never copied again blindly.
// - after the copy is made, nothing is deleted. On any failure the copy stays a draft; the script
//   prints its id and exactly what is left to do, loudly.
// - every printed line is cleaned of control characters; the key is never printed; Node flags and
//   NODE_OPTIONS are refused, as are proxy and risky TLS settings.
//
// The key is read by name from ~/.config/shelfready/dev.env as MAILCHIMP_API_KEY.
// Exit codes: 0 done (or the dry run worked); 1 something failed; 2 stopped by a rule, nothing changed.

import { riskyEnvironment } from '../../src/lib/risky-env.ts';
import { createMailchimpClient, MailchimpError, setupProblem, type Campaign, type MailchimpApi } from '../../src/mailchimp/client.ts';
import { loadMailchimpConfig, localCampaignId, type MailchimpConfig } from '../../src/mailchimp/config.ts';
import { dateLineText, fishTitle, localParts, localToUtc, mailchimpTime } from '../../src/mailchimp/days.ts';
import { checkRemoval, editEmail, parseRows, removeRow, setDateLine, verifyEmail, type FishRow } from '../../src/mailchimp/html.ts';
import { isFishEmail } from '../../src/mailchimp/target.ts';
import { baseTitle } from '../../src/mailchimp/worker.ts';
import { BACKUP_DIR, guardFetch, LOOK_CALLS, plainTextIsMailchimps, saveBackup, type Allowed } from './remove-row.ts';
import { clean } from '../lib/clean.ts';

/** The name, under "campaigns" in config/local/mailchimp.json, of Monday's sent email (Bart named it). */
export const SOURCE_NAME = 'makeWednesdaySource';
export const SEND_DAY = '2026-11-11';
export const REMOVE_KEY = "Bart's Lobster Stock (8 oz (1 cup))";

/** Bart's approved corrections: the row key, the price the email shows now, Square's price, the unit. */
export const PRICE_FIXES: ReadonlyArray<{ key: string; from: string; to: number; unit: string }> = [
  { key: 'Live Lobster, 1–1.5 lb', from: '$28.99', to: 2499, unit: 'lb' },
  { key: 'Live Lobster, 1.5–2 lb', from: '$30.99', to: 2999, unit: 'lb' },
  { key: 'Live Lobster, 2–3 lb', from: '$30.99', to: 2999, unit: 'lb' },
  { key: 'Lump Crab Meat (1 lb can, cooked)', from: '$43.99', to: 7599, unit: 'can' },
  { key: 'Jumbo Crab Meat (1 lb can, cooked)', from: '$84.99', to: 9999, unit: 'can' },
  // The email disagrees with the scales (the register price); Bart approved matching them.
  { key: 'Bigeye Tuna', from: '$42.99', to: 4399, unit: 'lb' },
  { key: 'Cod (Iceland)', from: '$40.99', to: 4199, unit: 'lb' },
];

const ID = '[a-z0-9]{6,20}';
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** Copying: the replicate on the source only, and the reads to find and check the copy. */
export function copyCalls(sourceId: string): Allowed[] {
  if (!new RegExp(`^${ID}$`).test(sourceId)) throw new Error('That is not a Mailchimp campaign id.');
  return [...LOOK_CALLS, { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${sourceId}/actions/replicate$`) }];
}

/** Writing: the new copy only, and only these. */
export function editCalls(copyId: string): Allowed[] {
  if (!new RegExp(`^${ID}$`).test(copyId)) throw new Error('That is not a Mailchimp campaign id.');
  return [
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${copyId}$`) },
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${copyId}/content$`) },
    { method: 'PUT', path: new RegExp(`^/3\\.0/campaigns/${copyId}/content$`) },
    { method: 'PATCH', path: new RegExp(`^/3\\.0/campaigns/${copyId}$`) },
    { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${copyId}/actions/schedule$`) },
  ];
}

function centsText(c: number): string {
  return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

export interface Planned {
  html: string;
  removed: { key: string; cuts: number; dividerFrom: string | null };
  prices: Array<{ key: string; from: string; to: string; unit: string }>;
  dateText: string;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

function splice(src: string, edits: readonly Splice[]): string {
  let out = '';
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) throw new Error('overlapping edits');
    out += src.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + src.slice(at);
}

/**
 * Works out the edited HTML from the source, locally, and checks it: the result must be the source
 * with exactly the row cuts, the seven prices and the date line, byte for byte, and every other row
 * the same. Returns the plan, or the reason to stop.
 */
export function planEdit(source: string, cfg: MailchimpConfig): Planned | string {
  const rows = parseRows(source);
  // The prices must be what Bart saw, each row exactly once.
  for (const f of PRICE_FIXES) {
    const found = rows.filter((r) => r.key === f.key);
    if (found.length !== 1) return `the row "${f.key}" is in the email ${found.length} times, not once.`;
    if (found[0]!.priceText !== f.from || found[0]!.unit !== f.unit) return `"${f.key}" shows ${found[0]!.priceText}/${found[0]!.unit}, not ${f.from}/${f.unit} as approved. Ask Bart.`;
  }
  // a. The row and its divider.
  const r = removeRow(source, REMOVE_KEY);
  if (r.kind === 'absent') return `the row "${REMOVE_KEY}" is not in the source email.`;
  if (r.kind === 'refused') return r.why;
  const cutProblems = checkRemoval(source, r.html, REMOVE_KEY, r.cuts);
  if (cutProblems.length) return `the removal would change more than the row and its divider: ${cutProblems.join(' ')}`;
  // b and c. The prices and the date line, through the same editor the worker uses.
  const dateText = dateLineText(SEND_DAY);
  const e = editEmail(r.html, PRICE_FIXES.map((f) => ({ key: f.key, toCents: f.to })), { units: cfg.units, dateLine: cfg.dateLine, dateText });
  if (e.refused.length) return `a price could not be changed: ${e.refused.map((x) => `"${x.key}": ${x.why}`).join(' ')}`;
  if (e.same.length || e.changes.length !== PRICE_FIXES.length) return 'not every price would change as approved.';
  for (const f of PRICE_FIXES) {
    const c = e.changes.find((x) => x.key === f.key);
    if (!c || c.fromText !== f.from || c.toText !== centsText(f.to)) return `"${f.key}" would not go from ${f.from} to ${centsText(f.to)}.`;
  }
  if (e.dateLineProblem || !e.dateLine || e.dateLine.from !== null) return `the date line: ${e.dateLineProblem || 'the source already has one, which is not expected.'}`;
  // The whole document, worked out a second way, from the source: the cuts, the prices at their
  // places in the source, and the date line where setDateLine puts it in the source.
  const withDate = setDateLine(source, cfg.dateLine, dateText);
  if (withDate.problem || !withDate.line) return `the date line: ${withDate.problem || 'not set.'}`;
  let at = 0;
  while (at < source.length && source[at] === withDate.html[at]) at++;
  const inserted = withDate.html.slice(at, at + withDate.html.length - source.length);
  if (withDate.html !== source.slice(0, at) + inserted + source.slice(at)) return 'the date line is not a single insertion.';
  const priceEdits: Splice[] = PRICE_FIXES.map((f) => {
    const row = rows.find((x) => x.key === f.key)!;
    return { start: row.priceStart, end: row.priceEnd, text: centsText(f.to) };
  });
  let expected: string;
  try {
    expected = splice(source, [...r.cuts.map((c) => ({ start: c.start, end: c.end, text: '' })), ...priceEdits, { start: at, end: at, text: inserted }]);
  } catch {
    return 'the changes overlap.';
  }
  if (e.html !== expected) return 'the edited email differs from the source by more than the approved changes.';
  const wrong = verifyEmail(e.html, { dateText, prices: e.changes.map((c) => ({ key: c.key, toText: c.toText })), dateLineClass: cfg.dateLine.class });
  if (wrong.length) return `the edited email does not check out: ${wrong.join('; ')}.`;
  const rowProblems = compareRows(source, e.html);
  if (rowProblems.length) return rowProblems.join(' ');
  return {
    html: e.html,
    removed: { key: r.row.key, cuts: r.cuts.length, dividerFrom: r.dividerFrom },
    prices: PRICE_FIXES.map((f) => ({ key: f.key, from: f.from, to: centsText(f.to), unit: f.unit })),
    dateText,
  };
}

/** Every row after is the source row, less the one removed, with only the seven prices changed. */
export function compareRows(source: string, after: string): string[] {
  const out: string[] = [];
  const want: FishRow[] = parseRows(source).filter((r) => r.key !== REMOVE_KEY);
  const got = parseRows(after);
  if (want.length !== got.length) return [`The email has ${got.length} rows, not ${want.length}.`];
  want.forEach((w, i) => {
    const g = got[i]!;
    const fix = PRICE_FIXES.find((f) => f.key === w.key);
    const price = fix ? centsText(fix.to) : w.priceText;
    if (g.key !== w.key || g.unit !== w.unit || g.section !== w.section || g.priceText !== price) out.push(`Row ${i + 1} is "${g.key}" ${g.priceText}, not "${w.key}" ${price}.`);
  });
  return out;
}

export interface MakeDeps {
  key: string;
  cfg: MailchimpConfig;
  /** The id of the sent email to copy, the one Bart named. */
  sourceId: string;
  apply: boolean;
  now: () => number;
  print: (line: string) => void;
  backupDir: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  /** Waits between reads. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

function when(ms: number | null, tz: string): string {
  if (ms === null) return 'not scheduled';
  const p = localParts(ms, tz);
  return `${p.weekday} ${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${tz}`;
}

/** The whole job. Returns the exit code. */
export async function makeWednesdayJob(d: MakeDeps): Promise<number> {
  const { cfg } = d;
  const print = (line: string): void => d.print(clean(line, Infinity));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tz = cfg.timeZone;
  const env = d.env ?? process.env;
  const execArgv = d.execArgv ?? process.execArgv;
  const stop = (why: string): number => {
    print(`Stopped: ${why}`);
    print('Nothing was changed in Mailchimp.');
    return 2;
  };
  if (riskyEnvironment(env, execArgv)) return stop('a proxy or certificate setting is set that could send the key elsewhere.');
  for (const v of PROXY_VARS) if (env[v]) return stop(`${v} is set. The key must go straight to Mailchimp.`);
  const problem = setupProblem({ key: () => d.key, env, execArgv });
  if (problem) return stop(problem);
  const inner = d.fetch ?? fetch;
  const sendAt = localToUtc(SEND_DAY, cfg.sendTime, tz);
  const cutoff = sendAt - cfg.safeMarginMinutes * 60_000;
  const title = fishTitle(cfg.titlePrefix, SEND_DAY);

  // 1. Look, reading only.
  const look = guardFetch(inner, LOOK_CALLS);
  const reader = createMailchimpClient({ key: () => d.key, fetch: look.fetch, now: d.now, env, execArgv, allowWrites: false });
  let source: Campaign;
  let sourceHtml: string;
  try {
    const listId = cfg.list.id;
    const sent = (await reader.listCampaigns({ listId, status: 'sent', sortField: 'send_time', count: 20 })).filter((c) => isFishEmail(c, cfg) && c.sendTime !== null && c.createTime !== null);
    sent.sort((a, b) => b.sendTime! - a.sendTime!);
    const last = sent[0];
    if (!last) return stop('no sent fish email was found on the fish list.');
    print(`Last fish email sent: "${clean(last.title)}" (${last.id}), ${when(last.sendTime, tz)}.`);
    if (last.id !== d.sourceId) return stop(`the last fish email sent is ${last.id}, not ${d.sourceId} as expected.`);
    source = last;
    const open = [
      ...(await reader.listCampaigns({ listId, status: 'save', sortField: 'create_time', count: 100 })),
      ...(await reader.listCampaigns({ listId, status: 'schedule', sortField: 'create_time', count: 100 })),
      // Any scheduled fish email stops it, however old (staff may have scheduled one ahead of time).
      // A draft counts only if it was made after the last one sent.
    ].filter((c) => isFishEmail(c, cfg) && (c.status === 'schedule' || (c.status === 'save' && c.createTime !== null && c.createTime > last.createTime!)));
    if (open.length) return stop(`a fish email after the last one sent already exists: ${[...new Map(open.map((c) => [c.id, c])).values()].map((c) => `"${clean(c.title)}" (${c.id}, ${c.status})`).join(', ')}. Use it, or remove it by hand first.`);
    if (d.now() >= cutoff) return stop(`it is ${when(d.now(), tz)}, inside the 60-minute cutoff before ${when(sendAt, tz)}.`);
    const content = await reader.getContentWithText(source.id);
    sourceHtml = content.html;
    if (!plainTextIsMailchimps(content.plainText)) return stop("the source's plain text looks written by hand. Sending new HTML would make Mailchimp replace it. Ask Bart.");
  } catch (err) {
    print(`Failed while reading Mailchimp: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
    if (look.refused.length) print(`Refused by this script's allowlist: ${look.refused.join(', ')}.`);
    print('Nothing was changed in Mailchimp.');
    return 1;
  }

  // 2. The edit, worked out and checked locally.
  const plan = planEdit(sourceHtml, cfg);
  if (typeof plan === 'string') return stop(plan);
  const summary = (id: string, status: string): void => {
    print('');
    print('Summary for Bart:');
    print(`  Campaign: "${title}" (${id}), ${status}.`);
    print(`  Send time: ${when(sendAt, tz)}.`);
    print(`  Removed: "${plan.removed.key}"${plan.removed.dividerFrom ? `, and the divider under "${plan.removed.dividerFrom}" that now ends its section` : ''}.`);
    for (const p of plan.prices) print(`  Price: ${p.key}, ${p.from}/${p.unit} to ${p.to}/${p.unit}.`);
    print(`  Date line at the top: "${plan.dateText}".`);
    print('  Subject line and everything else: as in the source.');
  };
  print(`The edit checks out locally: the source less one row${plan.removed.dividerFrom ? ' and one divider' : ''}, seven prices and the date line, and nothing else.`);
  if (!d.apply) {
    summary('not made yet', 'dry run');
    print('Dry run. Nothing was changed. Run again with --apply to make it.');
    return 0;
  }
  const backup = saveBackup(d.backupDir, source.id, sourceHtml, d.now());
  print(`Saved the source HTML to ${backup}.`);

  // 3. The copy.
  const copyGuard = guardFetch(inner, copyCalls(source.id));
  const copier = createMailchimpClient({ key: () => d.key, fetch: copyGuard.fetch, now: d.now, env, execArgv, allowWrites: true });
  const started = d.now();
  let copy: Campaign | null = null;
  try {
    copy = await copier.replicate(source.id);
  } catch (err) {
    if (copyGuard.refused.length) return stop(`refused by this script's allowlist before it was sent: ${copyGuard.refused.join(', ')}.`);
    if (!(err instanceof MailchimpError) || err.kind !== 'unknown') {
      if (copyGuard.refused.length) print(`Refused by this script's allowlist: ${copyGuard.refused.join(', ')}.`);
      return stop(`Mailchimp refused the copy. ${err instanceof Error ? err.message : ''}`.trim());
    }
    // The answer was lost: look for the copy, never copy again.
    print('Mailchimp did not answer the copy. Looking for it instead of copying again.');
    for (let attempt = 0; attempt < 3 && !copy; attempt++) {
      if (attempt) await sleep(20_000);
      try {
        const drafts = (await copier.listCampaigns({ listId: cfg.list.id, status: 'save', sortField: 'create_time', count: 50 })).filter(
          (c) => baseTitle(c.title) === baseTitle(source.title) && c.listId === cfg.list.id && c.createTime !== null && c.createTime >= started - 60_000,
        );
        const same: Campaign[] = [];
        for (const c of drafts) if ((await copier.getContent(c.id)) === sourceHtml) same.push(c);
        if (same.length > 1) return loud([`Mailchimp may have made ${same.length} copies: ${same.map((c) => c.id).join(', ')}. Keep one, delete the others by hand, then finish it by hand.`]);
        if (same.length === 1) copy = same[0]!;
      } catch {
        // Look again.
      }
    }
    if (!copy) return loud(['Mailchimp did not answer the copy, and no copy was found. Check the drafts in Mailchimp before doing anything else. Do not run this again until you have.']);
  }
  const id = copy.id;
  print(`Copied: "${clean(copy.title)}" (${id}).`);
  // Wait until it reads back as a draft on the fish list.
  let ready = false;
  for (let i = 0; i < 5 && !ready; i++) {
    if (i) await sleep(2_000);
    try {
      const c = await copier.getCampaign(id);
      ready = c.status === 'save' && c.listId === cfg.list.id;
    } catch {
      // Read again.
    }
  }
  const left = (steps: string[]): string => `The copy ${id} stays a draft. Left to do by hand in Mailchimp: ${steps.join('; ')}.`;
  const allSteps = [`remove "${REMOVE_KEY}" and the divider above it`, 'set the seven prices', `add the date line "${plan.dateText}"`, `name it "${title}"`, `schedule it for ${when(sendAt, tz)}`];
  if (!ready) return loud([`The copy ${id} did not read back as a draft on the fish list.`, left(allSteps)]);

  // 4. Edit the copy, name it, check it, schedule it.
  const guard = guardFetch(inner, editCalls(id));
  const api = createMailchimpClient({ key: () => d.key, fetch: guard.fetch, now: d.now, env, execArgv, allowWrites: true });
  const refusedNote = (): string[] => (guard.refused.length || copyGuard.refused.length ? [`Refused by this script's allowlist: ${[...copyGuard.refused, ...guard.refused].join(', ')}.`] : []);
  let scheduled = false;
  try {
    const copyHtml = await api.getContent(id);
    if (copyHtml !== sourceHtml) return loud(['The copy\'s HTML is not the same as the source\'s, so it was not edited.', left(allSteps), ...refusedNote()]);
    try {
      await api.putContent(id, plan.html);
    } catch {
      // The read below says whether it landed.
    }
    const back = await api.getContentWithText(id);
    if (back.html !== plan.html) {
      return loud([back.html === sourceHtml ? 'The new HTML did NOT land: the copy still holds the source email.' : 'The copy holds HTML that is not the expected one.', left(allSteps), ...refusedNote()]);
    }
    print(`Edited ${id}: read back byte for byte as planned.`);
    // The title, with every other setting sent back as read.
    const before = await api.getCampaign(id);
    try {
      await api.setTitle(id, { title, subject_line: before.subjectLine, from_name: before.fromName, reply_to: before.replyTo, preview_text: before.previewText, to_name: before.toName });
    } catch {
      // The read below says whether it landed.
    }
    const named = await api.getCampaign(id);
    const moved = (['subjectLine', 'fromName', 'replyTo', 'previewText', 'toName'] as const).filter((k) => named[k] !== before[k]);
    if (named.title !== title) return loud([`The name did not change to "${title}".`, left([`name it "${title}"`, `schedule it for ${when(sendAt, tz)}`]), ...refusedNote()]);
    if (moved.length) return loud([`Setting the name also changed ${moved.join(', ')}. Check them.`, left([`check ${moved.join(', ')}`, `schedule it for ${when(sendAt, tz)}`]), ...refusedNote()]);
    if (named.subjectLine !== source.subjectLine) return loud(['The subject line is not the source\'s.', left([`check the subject line`, `schedule it for ${when(sendAt, tz)}`]), ...refusedNote()]);
    print(`Named "${title}". Subject, sender, reply-to, preview text and to-name are unchanged.`);
    if (d.now() >= cutoff) return loud([`It is now inside the cutoff, so it was not scheduled.`, left([`schedule it for ${when(sendAt, tz)}, or send it by hand`]), ...refusedNote()]);
    for (let i = 0; i < 2 && !scheduled; i++) {
      try {
        await api.schedule(id, mailchimpTime(sendAt));
      } catch {
        // The read below says whether it landed.
      }
      try {
        const c = await api.getCampaign(id);
        scheduled = c.status === 'schedule' && c.sendTime === sendAt;
      } catch {
        // Not confirmed.
      }
    }
    if (!scheduled) return loud(['IT IS NOT SCHEDULED.', left([`schedule it for ${when(sendAt, tz)}`]), ...refusedNote()]);
    print(`Scheduled for ${when(sendAt, tz)}, and read back.`);
    // A last look at what will go out.
    const final = await api.getContent(id);
    if (final !== plan.html) return loud([`It IS scheduled for ${when(sendAt, tz)}, but its HTML now reads back differently. Check it in Mailchimp before it goes.`, ...refusedNote()]);
  } catch (err) {
    const why = err instanceof MailchimpError ? err.message : 'something went wrong.';
    return loud(scheduled ? [`It IS scheduled for ${when(sendAt, tz)}, but a later check failed: ${why} Check it in Mailchimp before it goes.`, ...refusedNote()] : [`Something failed: ${why}`, left(['check what is done', 'finish the rest']), ...refusedNote()]);
  }
  summary(id, 'scheduled');
  print('Done.');
  return 0;

  function loud(lines: string[]): number {
    print('**************** FAILED ****************');
    for (const l of lines) print(`FAILED: ${l}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--apply') || args.length > 1) throw new Error('Usage: node scripts/mailchimp/make-wednesday.ts [--apply]');
  // A preload or inspector could read the key, so no Node flags at all, as in scripts/net/cert-lib.ts.
  if (process.env.NODE_OPTIONS || process.execArgv.length > 0) throw new Error('Refusing to run with NODE_OPTIONS or a Node flag set: run it as node scripts/mailchimp/make-wednesday.ts [--apply].');
  const risky = riskyEnvironment();
  if (risky) throw new Error(`Refusing to run: ${risky}`);
  const { devEnvValue } = await import('../lib/dev-env.ts');
  const sourceId = localCampaignId(SOURCE_NAME);
  if (!sourceId) throw new Error(`Add campaigns.${SOURCE_NAME}, the id of the sent email to copy, to config/local/mailchimp.json.`);
  const key = devEnvValue('MAILCHIMP_API_KEY');
  process.exitCode = await makeWednesdayJob({ key, cfg: loadMailchimpConfig(), sourceId, apply: args[0] === '--apply', now: Date.now, print: (l) => console.log(l), backupDir: BACKUP_DIR });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Failed.');
    process.exitCode = 1;
  });
}
