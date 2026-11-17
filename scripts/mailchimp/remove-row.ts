// One-off, authorized by Bart on November 9, 2026 (store/docs/DECISIONS.md, Fish prices in Mailchimp):
// remove the row "Bart's Lobster Stock (8 oz (1 cup))" from the next fish email, the one for
// Wednesday, November 11, 2026. It is out, with no date for more.
//
//   node scripts/mailchimp/remove-row.ts            dry run: reads only, changes nothing
//   node scripts/mailchimp/remove-row.ts --apply    removes the row
//
// Safety, on top of src/mailchimp/client.ts (host from the key's data center, no redirects, no
// proxy or risky TLS settings, the key only in the Authorization header, never printed):
// - every request also passes this script's own allowlist, checked on the method and the exact
//   path before it leaves: while looking, only reads; while writing, only these calls for the one
//   campaign found: read it, read its content, PUT its content, unschedule it, schedule it again.
//   Nothing else, ever: no copy, no rename, no send, no delete, no other campaign.
// - the target must be the only draft or scheduled fish email on the fish list made after the
//   last one sent; a scheduled one must be for Wednesday, November 11, 2026 at 8:00am Chicago;
//   nothing is done inside the 60-minute cutoff (from 7:00am that day).
// - only the smallest element that is exactly that row is removed. When it is the last row of its
//   section, the bottom divider of the row that becomes last goes too, so the section ends like
//   every other one (src/mailchimp/html.ts removeRow). The rest is byte for byte the same, checked
//   before and after.
// - the plain text is never sent. If the campaign's plain text looks set by hand, it stops, since
//   Mailchimp makes a new plain text from the HTML when only HTML is sent.
// - before writing, the original HTML is saved in data/mailchimp/backups/ (mode 600, folder 700).
// - a scheduled email is unscheduled, changed, and scheduled again for the same time. If the
//   change fails after the unschedule, it is scheduled again anyway, and the failure is printed
//   loudly (Bart, November 9).
//
// The key is read by name from ~/.config/shelfready/dev.env as MAILCHIMP_API_KEY.
// Exit codes: 0 done, or nothing to do; 1 something failed; 2 stopped by a rule, nothing changed.

import { chmodSync, closeSync, constants as fsc, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { riskyEnvironment } from '../../src/lib/risky-env.ts';
import { createMailchimpClient, MailchimpError, setupProblem, type Campaign, type MailchimpApi } from '../../src/mailchimp/client.ts';
import { loadMailchimpConfig, type MailchimpConfig } from '../../src/mailchimp/config.ts';
import { localParts, localToUtc, mailchimpTime } from '../../src/mailchimp/days.ts';
import { checkRemoval, removeRow } from '../../src/mailchimp/html.ts';
import { isFishEmail } from '../../src/mailchimp/target.ts';
import { clean } from '../lib/clean.ts';

export const ROW_KEY = "Bart's Lobster Stock (8 oz (1 cup))";
export const SEND_DAY = '2026-11-11';
export const BACKUP_DIR = join(import.meta.dirname, '..', '..', 'data', 'mailchimp', 'backups');

const ID = '[a-z0-9]{6,20}';
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

export interface Allowed {
  method: string;
  path: RegExp;
}

/** The reads used to find the campaign. */
export const LOOK_CALLS: readonly Allowed[] = [
  { method: 'GET', path: /^\/3\.0\/campaigns$/ },
  { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${ID}$`) },
  { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${ID}/content$`) },
];

/** Every call allowed while writing: the one campaign, and only these. */
export function writeCalls(id: string): Allowed[] {
  if (!new RegExp(`^${ID}$`).test(id)) throw new Error('That is not a Mailchimp campaign id.');
  return [
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${id}$`) },
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${id}/content$`) },
    { method: 'PUT', path: new RegExp(`^/3\\.0/campaigns/${id}/content$`) },
    { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${id}/actions/unschedule$`) },
    { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${id}/actions/schedule$`) },
  ];
}

/**
 * A fetch that sends only allowed calls, to the Mailchimp API host, with redirects refused.
 * Anything else is refused before it leaves, and listed in refused.
 */
export function guardFetch(inner: typeof fetch, allowed: readonly Allowed[]): { fetch: typeof fetch; refused: string[] } {
  const refused: string[] = [];
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const hostOk = url.protocol === 'https:' && /^us[0-9]{1,3}\.api\.mailchimp\.com$/.test(url.hostname) && url.port === '';
    const ok = hostOk && init?.redirect === 'error' && !url.username && !url.password && allowed.some((a) => a.method === method && a.path.test(url.pathname));
    if (!ok) {
      refused.push(`${method} ${url.pathname}`);
      throw new Error('refused by remove-row.ts');
    }
    return inner(url, init);
  }) as typeof fetch;
  return { fetch: guarded, refused };
}

/**
 * Mailchimp's own plain text, made from the HTML, marks headings with "** " and underlines them
 * with a row of dashes. The saved fish emails all look like this. An empty one is fine too.
 */
export function plainTextIsMailchimps(text: string): boolean {
  if (text.trim() === '') return true;
  return /^\*\* \S/m.test(text) && /^-{20,}$/m.test(text);
}

export interface RemoveDeps {
  key: string;
  cfg: MailchimpConfig;
  apply: boolean;
  now: () => number;
  print: (line: string) => void;
  backupDir: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
}

function when(ms: number | null, tz: string): string {
  if (ms === null) return 'not scheduled';
  const p = localParts(ms, tz);
  return `${p.weekday} ${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${tz}`;
}

/** Saves the original HTML before any write: a new file, mode 600, in a mode 700 folder. */
export function saveBackup(dir: string, id: string, html: string, now: number): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error('The backup folder is not a plain folder of yours.');
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.html`);
  const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, html);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return path;
}

async function scheduleChecked(api: MailchimpApi, id: string, at: number): Promise<boolean> {
  try {
    await api.schedule(id, mailchimpTime(at));
  } catch {
    // Refused or no answer: the read below says what Mailchimp holds.
  }
  try {
    const c = await api.getCampaign(id);
    return c.status === 'schedule' && c.sendTime === at;
  } catch {
    return false;
  }
}

/** The whole job. Returns the exit code. */
export async function removeRowJob(d: RemoveDeps): Promise<number> {
  const { cfg } = d;
  // Every line goes through clean(): rows, sections, excerpts and failures quote text from the email.
  const print = (line: string): void => d.print(clean(line, Infinity));
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

  // 1. Find the campaign, reading only.
  const look = guardFetch(inner, LOOK_CALLS);
  const reader = createMailchimpClient({ key: () => d.key, fetch: look.fetch, now: d.now, env, execArgv, allowWrites: false });
  const sendAt = localToUtc(SEND_DAY, cfg.sendTime, tz);
  const cutoff = sendAt - cfg.safeMarginMinutes * 60_000;
  let target: Campaign;
  let html: string;
  let plainText: string;
  try {
    const listId = cfg.list.id;
    const sent = (await reader.listCampaigns({ listId, status: 'sent', sortField: 'send_time', count: 20 })).filter((c) => isFishEmail(c, cfg) && c.sendTime !== null && c.createTime !== null);
    sent.sort((a, b) => b.sendTime! - a.sendTime!);
    const last = sent[0];
    if (!last) return stop('no sent fish email was found on the fish list.');
    print(`Last fish email sent: "${clean(last.title)}" (${last.id}), ${when(last.sendTime, tz)}.`);
    const open = [
      ...(await reader.listCampaigns({ listId, status: 'save', sortField: 'create_time', count: 100 })),
      ...(await reader.listCampaigns({ listId, status: 'schedule', sortField: 'create_time', count: 100 })),
    ].filter((c) => isFishEmail(c, cfg) && (c.status === 'save' || c.status === 'schedule') && c.createTime !== null && c.createTime > last.createTime!);
    const candidates = [...new Map(open.map((c) => [c.id, c])).values()];
    if (candidates.length === 0) return stop(`there is no draft or scheduled fish email made after "${clean(last.title)}" yet. Staff have not made Wednesday's email. Run this again once they have.`);
    if (candidates.length > 1) return stop(`there are ${candidates.length} draft or scheduled fish emails made after the last one sent: ${candidates.map((c) => `"${clean(c.title)}" (${c.id}, ${c.status})`).join(', ')}. Expected exactly one.`);
    target = candidates[0]!;
    print(`Target: "${clean(target.title)}" (${target.id}), status ${target.status}, send time ${when(target.sendTime, tz)}.`);
    if (d.now() >= cutoff) return stop(`it is ${when(d.now(), tz)}, inside the 60-minute cutoff before ${when(sendAt, tz)}.`);
    if (target.status === 'schedule' && target.sendTime !== sendAt) return stop(`it is scheduled for ${when(target.sendTime, tz)}, not ${when(sendAt, tz)}.`);
    const content = await reader.getContentWithText(target.id);
    html = content.html;
    plainText = content.plainText;
  } catch (err) {
    print(`Failed while reading Mailchimp: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
    if (look.refused.length) print(`Refused by this script's allowlist: ${look.refused.join(', ')}.`);
    print('Nothing was changed in Mailchimp.');
    return 1;
  }
  if (!plainTextIsMailchimps(plainText)) return stop('its plain text looks written by hand. Sending new HTML would make Mailchimp replace it. Ask Bart.');
  print(`Plain text: ${plainText.trim() === '' ? 'none set' : "Mailchimp's own, made from the HTML"}. This script never sends plain text.`);

  // 2. Work out the change.
  const r = removeRow(html, ROW_KEY);
  if (r.kind === 'absent') {
    print(`The row "${ROW_KEY}" is not in this email. Nothing to do. Nothing was changed.`);
    return 0;
  }
  if (r.kind === 'refused') return stop(r.why);
  const wrong = checkRemoval(html, r.html, ROW_KEY, r.cuts);
  if (wrong.length) return stop(`the removal would change more than the row and its section's divider: ${wrong.join(' ')}`);
  print(`Row to remove: "${r.row.key}", ${r.row.priceText}/${r.row.unit}, in "${r.row.section}".`);
  for (const c of r.cuts) {
    print(c.what === 'row' ? `Markup removed (${c.text.length} characters, the whole table row):` : `Divider removed from "${r.dividerFrom}", now the last row of its section, like the last row of every other section:`);
    print(`    ...${html.slice(Math.max(0, c.start - 60), c.start)}`);
    print(`  - ${c.text}`);
    print(`    ${html.slice(c.end, c.end + 60)}...`);
  }
  if (!r.dividerFrom) print('The row is not the last in its section, so no divider changes.');
  if (!d.apply) {
    print('Dry run. Nothing was changed. Run again with --apply to remove the row.');
    return 0;
  }

  // 3. Write, to this one campaign only.
  const guard = guardFetch(inner, writeCalls(target.id));
  const api = createMailchimpClient({ key: () => d.key, fetch: guard.fetch, now: d.now, env, execArgv, allowWrites: true });
  const id = target.id;
  const backup = saveBackup(d.backupDir, id, html, d.now());
  print(`Saved the original HTML to ${backup}.`);
  const failures: string[] = [];
  const scheduled = target.status === 'schedule';
  // From the moment the unschedule is asked for, the email must be scheduled again.
  let mustReschedule = false;
  try {
    if (scheduled) {
      mustReschedule = true;
      try {
        await api.unschedule(id);
      } catch {
        // The read below says what happened.
      }
      const back = await api.getCampaign(id);
      if (back.status === 'schedule') {
        mustReschedule = false;
        return stop('Mailchimp did not unschedule it, so the row could not be removed. The email goes out as it was.');
      }
      // Not returned early: the failure is printed below, with whatever the reschedule adds.
      if (back.status !== 'save' && back.status !== 'paused') failures.push(`After the unschedule the campaign is "${clean(back.status)}", so the row was not removed. Check it in Mailchimp now.`);
      else print(`Unscheduled ${id}.`);
    }
    if (!failures.length) {
      let putError = '';
      try {
        await api.putContent(id, r.html);
      } catch (err) {
        putError = err instanceof MailchimpError ? err.message : 'something went wrong.';
      }
      const after = await api.getContentWithText(id).catch(() => null);
      if (!after) failures.push('Could not read the email back after the change.');
      else if (after.html === r.html) {
        const left = checkRemoval(html, after.html, ROW_KEY, r.cuts);
        if (left.length) failures.push(...left);
        else print(`Removed the row${r.dividerFrom ? ' and the one divider' : ''}. Read back: the row is gone and the rest is byte for byte the same.${after.plainText.includes('Lobster Stock') ? ' Note: the plain text still lists it.' : ' The plain text no longer lists it.'}`);
      } else if (after.html === html) failures.push(`The row was NOT removed: the email is unchanged.${putError ? ` ${putError}` : ''}`);
      else failures.push('The email Mailchimp holds now is not exactly the expected one. Compare it with the backup.');
    }
  } catch (err) {
    failures.push(`Something failed while writing: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
  } finally {
    if (mustReschedule) {
      let ok = await scheduleChecked(api, id, sendAt);
      if (!ok) ok = await scheduleChecked(api, id, sendAt);
      if (ok) print(`Scheduled again for ${when(sendAt, tz)}, and read back.`);
      else failures.push(`IT IS NOT SCHEDULED. Schedule ${id} by hand in Mailchimp now, for ${when(sendAt, tz)}.`);
    }
  }
  if (guard.refused.length) failures.push(`Refused by this script's allowlist: ${guard.refused.join(', ')}.`);
  if (failures.length) {
    print('**************** FAILED ****************');
    for (const f of failures) print(`FAILED: ${f}`);
    print(`The original HTML is in ${backup}.`);
    return 1;
  }
  print('Done.');
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--apply') || args.length > 1) throw new Error('Usage: node scripts/mailchimp/remove-row.ts [--apply]');
  // A preload or inspector could read the key, so no Node flags at all, as in scripts/net/cert-lib.ts.
  if (process.env.NODE_OPTIONS || process.execArgv.length > 0) throw new Error('Refusing to run with NODE_OPTIONS or a Node flag set: run it as node scripts/mailchimp/remove-row.ts [--apply].');
  const risky = riskyEnvironment();
  if (risky) throw new Error(`Refusing to run: ${risky}`);
  const { devEnvValue } = await import('../lib/dev-env.ts');
  const key = devEnvValue('MAILCHIMP_API_KEY');
  process.exitCode = await removeRowJob({ key, cfg: loadMailchimpConfig(), apply: args[0] === '--apply', now: Date.now, print: (l) => console.log(l), backupDir: BACKUP_DIR });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Failed.');
    process.exitCode = 1;
  });
}
