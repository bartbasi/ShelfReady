// One-off live test of ShelfReady's Mailchimp code (store/docs/MAILCHIMP-NOTES.md, "A safe live test").
// Bart asked for it on November 12, 2026. It runs only against a test campaign on the audience
// "Cheese & Crackers TEST", whose only member is Bart, so if anything goes wrong the only person
// who could get an email is Bart.
//
// Bart first makes the test campaign by hand: he replicates a past fish email, points the copy at
// that audience, and names it "TEST ShelfReady, do not send". Then:
//
//   node scripts/mailchimp/live-test.ts <campaign id>            dry run: reads only
//   node scripts/mailchimp/live-test.ts <campaign id> --apply    the live test
//
// It uses ShelfReady's own client and edit code (src/mailchimp/), not a copy, so the test proves
// the code that will run: the client's replicate, the worker's checked rename, content put,
// schedule and unschedule, and the editor's date line and price change.
//
// What --apply does, on a copy of the test campaign only:
//   1. replicates the test campaign, and checks the copy: a draft on the TEST audience, one
//      recipient, titled like the source with " (copy NN)", HTML byte for byte the source's;
//   2. renames the copy and reads back that subject, sender, reply-to, preview text and to-name
//      did not change;
//   3. puts edited HTML (a new date line and one changed price) and reads it back byte for byte,
//      and reports whether Mailchimp made a new plain text with the new date line;
//   4. schedules the copy at least 7 days ahead, on a quarter hour, reads it back, unschedules it,
//      and reads back that it is a draft again.
// It never sends, never test-sends, never deletes, never touches any other campaign, and never
// schedules less than 24 hours ahead. Bart deletes both test campaigns by hand afterwards.
//
// Safety, as in scripts/mailchimp/make-wednesday.ts, on top of src/mailchimp/client.ts:
// - every request passes this script's own allowlist, per phase, on the method and exact path:
//   looking, reads only; copying, POST replicate on the test campaign only, plus reads; editing,
//   for the copy only: read it, read its content, PATCH its title, PUT its content, schedule and
//   unschedule it. Nothing else, ever.
// - before every write, the campaign is read again: it must be the test campaign (for the copy)
//   or the copy made in step 1, on the TEST audience, with exactly one recipient.
// - the client's write gate is opened for this run only, by --apply, and only for this script's
//   client: allowMailchimpWrites in the server config is not read or changed.
// - the key is read by name from ~/.config/shelfready/dev.env and never printed; Node flags,
//   NODE_OPTIONS, proxies and risky TLS settings are refused; every printed line is cleaned.
//
// Exit codes: 0 done (or the dry run worked); 1 something failed; 2 stopped by a check, nothing changed.

import { riskyEnvironment } from '../../src/lib/risky-env.ts';
import { createMailchimpClient, MailchimpError, setupProblem, type Audience, type Campaign, type MailchimpApi } from '../../src/mailchimp/client.ts';
import { loadMailchimpConfig, localCampaignId, type MailchimpConfig } from '../../src/mailchimp/config.ts';
import { dateLineText, localParts, mailchimpTime } from '../../src/mailchimp/days.ts';
import { centsText, editEmail, parseRows, rowProblem } from '../../src/mailchimp/html.ts';
import { baseTitle, putContentChecked, scheduleChecked, setTitleChecked, unscheduleChecked } from '../../src/mailchimp/worker.ts';
import { guardFetch, LOOK_CALLS, type Allowed } from './remove-row.ts';
import { clean } from '../lib/clean.ts';

export const TEST_AUDIENCE = 'Cheese & Crackers TEST';
export const TEST_TITLE = 'TEST ShelfReady, do not send';
/**
 * The name, under "campaigns" in config/local/mailchimp.json, of the last whole-list fish send
 * (Friday, November 13), read only, for the segment check. The id is store data, out of git.
 */
export const WHOLE_LIST_SEND_NAME = 'liveTestWholeListSend';
/** The copy is scheduled this far ahead, then unscheduled at once. */
export const SCHEDULE_AHEAD_MS = 8 * 86400_000;
/** Never schedule closer than this. */
export const MIN_AHEAD_MS = 24 * 3600_000;
/** A lost copy is looked for this many times, this far apart. */
export const LOST_LOOKS = 3;
export const LOST_LOOK_GAP_MS = 10_000;
/** The plain text is read this many times, this far apart, before it counts as not made again. */
export const PLAIN_LOOKS = 4;
export const PLAIN_LOOK_GAP_MS = 10_000;

/** Where two texts first differ (the shorter length when one is the start of the other). */
export function firstDifference(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const ID = /^[a-z0-9]{6,20}$/;
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** Looking: the reads, and the audience list. */
export const READ_CALLS: readonly Allowed[] = [...LOOK_CALLS, { method: 'GET', path: /^\/3\.0\/lists$/ }];

/** Copying: the replicate on the test campaign only, plus the reads to find and check the copy. */
export function copyCalls(testId: string): Allowed[] {
  if (!ID.test(testId)) throw new Error('That is not a Mailchimp campaign id.');
  return [...LOOK_CALLS, { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${testId}/actions/replicate$`) }];
}

/** Editing: the copy only, and only these. */
export function editCalls(copyId: string): Allowed[] {
  if (!ID.test(copyId)) throw new Error('That is not a Mailchimp campaign id.');
  return [
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${copyId}$`) },
    { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${copyId}/content$`) },
    { method: 'PATCH', path: new RegExp(`^/3\\.0/campaigns/${copyId}$`) },
    { method: 'PUT', path: new RegExp(`^/3\\.0/campaigns/${copyId}/content$`) },
    { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${copyId}/actions/schedule$`) },
    { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${copyId}/actions/unschedule$`) },
  ];
}

/** The next quarter hour at least `ahead` after now. */
export function quarterAfter(now: number, ahead: number): number {
  const q = 15 * 60_000;
  return Math.ceil((now + ahead) / q) * q;
}

export type Verdict = 'confirmed' | 'contradicted' | 'not tested';

/** The items of "To check in the first live test" (store/docs/MAILCHIMP-NOTES.md), in order. */
export const CHECKLIST = [
  'title: PATCH keeps subject, sender, reply-to, preview text and to-name',
  'content: a PUT of HTML reads back byte for byte',
  'replicate: the copy holds the source HTML byte for byte',
  'content: a PUT of only the HTML gets a new plain text from Mailchimp',
  'unschedule: the status is save (or paused) afterwards',
  'replicate: the copy is a draft on the same audience, titled with its own (copy NN)',
  'segments: a whole-list fish send shows no segment in segment_opts',
  'segments: a segment send shows one in segment_opts',
  'GET campaigns with status=schedule lists the scheduled campaigns on the list',
  'Mailchimp accepts the key in a Bearer header',
] as const;
type Item = (typeof CHECKLIST)[number];

export interface LiveDeps {
  key: string;
  cfg: MailchimpConfig;
  campaignId: string;
  /** A whole-list fish send to read for the segment check. Null: that check is not tested. */
  wholeListSend: string | null;
  apply: boolean;
  now: () => number;
  print: (line: string) => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  /** Waits between looks. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

/** The whole job. Returns the exit code. */
export async function liveTestJob(d: LiveDeps): Promise<number> {
  const { cfg } = d;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = (line: string): void => d.print(clean(line, Infinity));
  const env = d.env ?? process.env;
  const execArgv = d.execArgv ?? process.execArgv;
  const tz = cfg.timeZone;
  const verdicts = new Map<Item, { v: Verdict; note: string }>(CHECKLIST.map((i) => [i, { v: 'not tested', note: '' }]));
  const mark = (i: Item, v: Verdict, note = ''): void => void verdicts.set(i, { v, note });
  const summary = (): void => {
    print('');
    print('What the live test showed (store/docs/MAILCHIMP-NOTES.md, To check in the first live test):');
    for (const [i, { v, note }] of verdicts) print(`  ${v.toUpperCase()}: ${i}${note ? `. ${note}` : ''}`);
  };
  const stop = (why: string): number => {
    print(`Stopped: ${why}`);
    print('Nothing was changed in Mailchimp.');
    summary();
    return 2;
  };
  const when = (ms: number | null): string => {
    if (ms === null) return 'no time';
    const p = localParts(ms, tz);
    return `${p.weekday} ${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${tz}`;
  };

  if (!ID.test(d.campaignId)) return stop('the campaign id does not look like a Mailchimp campaign id.');
  if (riskyEnvironment(env, execArgv)) return stop('a proxy or certificate setting is set that could send the key elsewhere.');
  for (const v of PROXY_VARS) if (env[v]) return stop(`${v} is set. The key must go straight to Mailchimp.`);
  const problem = setupProblem({ key: () => d.key, env, execArgv });
  if (problem) return stop(problem);
  const inner = d.fetch ?? fetch;

  // 1. Read-only checks.
  const look = guardFetch(inner, READ_CALLS);
  const reader = createMailchimpClient({ key: () => d.key, fetch: look.fetch, now: d.now, env, execArgv, allowWrites: false });
  let audience: Audience;
  let source: Campaign;
  let sourceHtml: string;
  try {
    const named = (await reader.listAudiences()).filter((a) => a.name === TEST_AUDIENCE);
    mark('Mailchimp accepts the key in a Bearer header', 'confirmed', 'the reads worked');
    if (named.length !== 1) return stop(`there are ${named.length} audiences named exactly "${TEST_AUDIENCE}", not one.`);
    audience = named[0]!;
    if (audience.id === cfg.list.id) return stop(`"${TEST_AUDIENCE}" is the fish list itself.`);
    if (audience.memberCount !== 1) return stop(`"${TEST_AUDIENCE}" has ${audience.memberCount ?? 'an unknown number of'} members, not exactly 1.`);
    print(`Test audience: "${TEST_AUDIENCE}" (${audience.id}), 1 member.`);
    source = await reader.getCampaign(d.campaignId);
    print(`Test campaign: "${clean(source.title)}" (${source.id}), status ${source.status}, list ${source.listId}, recipients ${source.recipientCount ?? 'unknown'}.`);
    if (source.listId !== audience.id) return stop(`the campaign is on list ${source.listId}, not the TEST audience.`);
    if (source.recipientCount !== 1) return stop(`the campaign has ${source.recipientCount ?? 'an unknown number of'} recipients, not exactly 1.`);
    if (source.status !== 'save') return stop(`the campaign's status is "${source.status}", not a draft (save).`);
    if (source.title !== TEST_TITLE) return stop(`the campaign is titled "${clean(source.title)}", not exactly "${TEST_TITLE}".`);
    sourceHtml = (await reader.getContentWithText(source.id)).html;

    // The segment fields of the last whole-list fish send.
    const wholeId = d.wholeListSend;
    if (wholeId === null || !ID.test(wholeId)) {
      print(`No whole-list fish send to read: add campaigns.${WHOLE_LIST_SEND_NAME} to config/local/mailchimp.json for the segment check.`);
      mark('segments: a whole-list fish send shows no segment in segment_opts', 'not tested', 'no whole-list send was named');
    } else {
      try {
        const whole = await reader.getCampaign(wholeId, { segmentText: true });
        print(`Last whole-list fish send ${whole.id}: segment_opts ${whole.segmentOptsRead ? `read, segment in it: ${whole.segmented ? 'YES' : 'no'}` : 'NOT in the reply'}; segment_text: "${clean(whole.segmentText, 300)}"; list ${whole.listId}; status ${whole.status}.`);
        // Confirmed only when the reply really held segment_opts and it shows no segment.
        mark(
          'segments: a whole-list fish send shows no segment in segment_opts',
          !whole.segmentOptsRead ? 'not tested' : whole.segmented ? 'contradicted' : 'confirmed',
          whole.segmentOptsRead ? `segment_text holds "${clean(whole.segmentText, 120)}"` : 'the reply did not include segment_opts',
        );
      } catch (err) {
        print(`Could not read ${wholeId}: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
      }
    }
    // The scheduled campaigns on the fish list, ids and titles only.
    const scheduled = await reader.listCampaigns({ listId: cfg.list.id, status: 'schedule', sortField: 'create_time', count: 100 });
    print(`Scheduled on the fish list: ${scheduled.length ? scheduled.map((c) => `"${clean(c.title)}" (${c.id})`).join(', ') : 'none'}.`);
    if (scheduled.length && scheduled.every((c) => c.status === 'schedule' && c.listId === cfg.list.id)) mark('GET campaigns with status=schedule lists the scheduled campaigns on the list', 'confirmed', `${scheduled.length} listed; check against Mailchimp by eye`);
    else if (scheduled.some((c) => c.status !== 'schedule' || c.listId !== cfg.list.id)) mark('GET campaigns with status=schedule lists the scheduled campaigns on the list', 'contradicted', 'it listed a campaign that is not scheduled on the list');
    else mark('GET campaigns with status=schedule lists the scheduled campaigns on the list', 'not tested', 'nothing is scheduled on the fish list now');
  } catch (err) {
    print(`Failed while reading Mailchimp: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
    if (look.refused.length) print(`Refused by this script's allowlist: ${look.refused.join(', ')}.`);
    print('Nothing was changed in Mailchimp.');
    summary();
    return 1;
  }

  // The edit, worked out locally: a new date line and one price up by $1.00.
  const at = quarterAfter(d.now(), SCHEDULE_AHEAD_MS);
  const day = localParts(at, tz).day;
  const dateText = dateLineText(day);
  const row = parseRows(sourceHtml).find((r) => rowProblem(r, cfg.units) === null && r.cents !== null && r.cents < 999_900);
  if (!row) return stop('the test campaign has no fish row ShelfReady can change.');
  const edit = editEmail(sourceHtml, [{ key: row.key, toCents: row.cents! + 100 }], { units: cfg.units, dateLine: cfg.dateLine, dateText });
  if (edit.changes.length !== 1 || !edit.dateLine || edit.dateLineProblem) return stop(`the edit does not work out on the test campaign: ${edit.dateLineProblem || edit.refused.map((r) => r.why).join(' ') || 'no change.'}`);
  const newTitle = `TEST ShelfReady do not send ${day.replace(/-/g, '')}`;
  print(`Planned on the copy: name "${newTitle}"; date line "${dateText}"; ${row.key} ${row.priceText} to ${centsText(row.cents! + 100)}; schedule for ${when(at)}, then unschedule.`);
  if (!d.apply) {
    print('Dry run. Nothing was changed. Run again with --apply for the live test.');
    summary();
    return 0;
  }

  // 2. The copy.
  const failures: string[] = [];
  const copyGuard = guardFetch(inner, copyCalls(source.id));
  const copier = createMailchimpClient({ key: () => d.key, fetch: copyGuard.fetch, now: d.now, env, execArgv, allowWrites: true });
  /** Before every write: the campaign must be the one expected, on the TEST audience, one recipient. */
  const guard = async (api: MailchimpApi, id: string): Promise<Campaign> => {
    const c = await api.getCampaign(id);
    if (c.id !== id || c.listId !== audience.id || c.recipientCount !== 1) {
      throw new GuardStop(`${id} is on list ${c.listId} with ${c.recipientCount ?? 'unknown'} recipients, not the TEST audience with 1. Nothing more was written.`);
    }
    return c;
  };
  let copy: Campaign | null = null;
  const started = d.now();
  try {
    await guard(copier, source.id);
    try {
      copy = await copier.replicate(source.id);
    } catch (err) {
      if (!(err instanceof MailchimpError) || err.kind !== 'unknown' || copyGuard.refused.length) throw err;
      // The answer was lost: look for the copy up to three times, about 10 seconds apart. Never copy again.
      print('Mailchimp did not answer the copy. Looking for it instead of copying again.');
      let same: Campaign[] = [];
      for (let look = 0; look < LOST_LOOKS && same.length === 0; look++) {
        if (look) await sleep(LOST_LOOK_GAP_MS);
        const drafts = (await copier.listCampaigns({ listId: audience.id, status: 'save', sortField: 'create_time', count: 50 })).filter(
          (c) => c.id !== source.id && baseTitle(c.title) === baseTitle(source.title) && c.createTime !== null && c.createTime >= started - 60_000,
        );
        same = [];
        for (const c of drafts) if ((await copier.getContent(c.id)) === sourceHtml) same.push(c);
      }
      if (same.length !== 1) throw new GuardStop(`Mailchimp did not answer the copy, and after ${LOST_LOOKS} looks ${same.length} drafts look like it. No second copy was made. Check the TEST audience's drafts by hand.`);
      copy = same[0]!;
      print(`Found the copy on a later look: ${copy.id}.`);
    }
    if (!copy) throw new GuardStop('Mailchimp made no copy.');
  } catch (err) {
    if (copyGuard.refused.length) print(`Refused by this script's allowlist: ${copyGuard.refused.join(', ')}.`);
    if (err instanceof GuardStop) return loud([err.message]);
    return loud([`The copy failed: ${err instanceof MailchimpError ? err.message : 'something went wrong.'} Check the TEST audience's drafts by hand.`]);
  }
  const made: Campaign = copy;
  const id = made.id;
  print(`Copied: "${clean(made.title)}" (${id}).`);

  // 3 to 5, on the copy only.
  const editGuard = guardFetch(inner, editCalls(id));
  const api = createMailchimpClient({ key: () => d.key, fetch: editGuard.fetch, now: d.now, env, execArgv, allowWrites: true });
  let scheduled = false;
  try {
    const c = await guard(api, id);
    const copyHtml = await api.getContent(id);
    const titled = new RegExp(`^${TEST_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(copy \\d+\\)$`).test(c.title);
    mark('replicate: the copy is a draft on the same audience, titled with its own (copy NN)', c.status === 'save' && titled ? 'confirmed' : 'contradicted', `status ${c.status}, title "${clean(c.title, 80)}"`);
    mark('replicate: the copy holds the source HTML byte for byte', copyHtml === sourceHtml ? 'confirmed' : 'contradicted', copyHtml === sourceHtml ? '' : `the copy has ${copyHtml.length} characters, the source ${sourceHtml.length}`);
    if (c.status !== 'save') throw new GuardStop(`the copy is "${c.status}", not a draft.`);
    // The copy's own HTML is edited, as the worker does.
    const myEdit = editEmail(copyHtml, [{ key: row.key, toCents: row.cents! + 100 }], { units: cfg.units, dateLine: cfg.dateLine, dateText });
    if (myEdit.changes.length !== 1 || !myEdit.dateLine) throw new GuardStop('the edit does not work out on the copy.');

    // Rename, with the worker's checked rename: it reads back the other five settings.
    const before = await guard(api, id);
    try {
      await setTitleChecked(api, before, newTitle);
      mark('title: PATCH keeps subject, sender, reply-to, preview text and to-name', 'confirmed', 'also look in Mailchimp itself');
      print(`Renamed to "${newTitle}". Subject, sender, reply-to, preview text and to-name read back unchanged.`);
    } catch (err) {
      const why = err instanceof MailchimpError ? err.message : 'something went wrong.';
      mark('title: PATCH keeps subject, sender, reply-to, preview text and to-name', /also changed/.test(why) ? 'contradicted' : 'not tested', why);
      throw err;
    }

    // Content, with the worker's checked put, then byte for byte, then the plain text.
    await guard(api, id);
    await putContentChecked(api, id, myEdit.html, { dateText, prices: myEdit.changes.map((x) => ({ key: x.key, toText: x.toText })), dateLineClass: cfg.dateLine.class });
    // putContentChecked passed: the date line and the price read back. Byte for byte is a separate
    // finding: if Mailchimp tidies the HTML, say where, and carry on.
    let back = await api.getContentWithText(id);
    if (back.html === myEdit.html) {
      mark('content: a PUT of HTML reads back byte for byte', 'confirmed');
      print(`Put the edited HTML: date line "${dateText}", ${row.key} to ${centsText(row.cents! + 100)}. Read back byte for byte.`);
    } else {
      const at0 = firstDifference(myEdit.html, back.html);
      const note = `first difference at character ${at0}: sent "${clean(myEdit.html.slice(at0, at0 + 40), 40)}", read back "${clean(back.html.slice(at0, at0 + 40), 40)}"`;
      mark('content: a PUT of HTML reads back byte for byte', 'contradicted', note);
      print(`Put the edited HTML. The date line and price read back, but not byte for byte: ${note}.`);
    }
    // The plain text may be built a moment after the PUT: look a few times over about 30 seconds.
    const want = (t: string): boolean => t.includes(dateText) && t.includes(centsText(row.cents! + 100));
    for (let look = 1; look < PLAIN_LOOKS && !want(back.plainText); look++) {
      await sleep(PLAIN_LOOK_GAP_MS);
      back = await api.getContentWithText(id);
    }
    const regenerated = want(back.plainText);
    mark(
      'content: a PUT of only the HTML gets a new plain text from Mailchimp',
      regenerated ? 'confirmed' : 'contradicted',
      `${regenerated ? 'the plain text shows the new date line and price' : `the plain text did not show the new date line and price after about ${((PLAIN_LOOKS - 1) * PLAIN_LOOK_GAP_MS) / 1000} seconds`}. Look at the plain text in Mailchimp too`,
    );
    print(`Plain text ${regenerated ? 'was made again by Mailchimp: it shows the new date line and price' : 'was NOT made again: it does not show the new date line and price'}. Look at it in Mailchimp too.`);

    // Schedule well ahead, read back, then unschedule at once.
    await guard(api, id);
    if (at - d.now() < MIN_AHEAD_MS) throw new GuardStop('the schedule time is less than 24 hours ahead.');
    scheduled = true;
    if (!(await scheduleChecked(api, id, at))) throw new GuardStop(`the copy did not read back as scheduled for ${when(at)}.`);
    print(`Scheduled for ${when(at)}, and read back.`);
    await guard(api, id);
    const after = await unscheduleChecked(api, id);
    if (after.status === 'schedule') throw new GuardStop('the copy did not unschedule.');
    scheduled = false;
    mark('unschedule: the status is save (or paused) afterwards', after.status === 'save' || after.status === 'paused' ? 'confirmed' : 'contradicted', `status ${after.status}`);
    print(`Unscheduled: status ${after.status}.`);
  } catch (err) {
    failures.push(err instanceof GuardStop ? err.message : `Something failed: ${err instanceof MailchimpError ? err.message : 'something went wrong.'}`);
  }
  if (editGuard.refused.length) failures.push(`Refused by this script's allowlist: ${editGuard.refused.join(', ')}.`);
  if (failures.length) {
    // Leave the copy unscheduled if it may be scheduled.
    if (scheduled) {
      try {
        const c = await unscheduleChecked(api, id);
        failures.push(c.status === 'schedule' ? `THE COPY ${id} IS STILL SCHEDULED. Unschedule it by hand in Mailchimp now.` : `The copy ${id} was unscheduled again.`);
      } catch {
        failures.push(`THE COPY ${id} MAY STILL BE SCHEDULED. Check it in Mailchimp now and unschedule it by hand.`);
      }
    }
    return loud(failures);
  }
  print('');
  print(`Done. Look at the copy "${newTitle}" (${id}) in Mailchimp's preview, then delete both test campaigns by hand: ${source.id} and ${id}. ShelfReady never deletes.`);
  summary();
  return 0;

  function loud(lines: string[]): number {
    print('**************** FAILED ****************');
    for (const l of lines) print(`FAILED: ${l}`);
    print(`Delete the test campaigns by hand once checked: ${d.campaignId}${copy ? ` and the copy ${(copy as Campaign).id}` : ' and any copy of it'}. ShelfReady never deletes.`);
    summary();
    return 1;
  }
}

class GuardStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardStop';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ids = args.filter((a) => a !== '--apply');
  if (ids.length !== 1 || args.length > 2 || !ID.test(ids[0]!)) throw new Error('Usage: node scripts/mailchimp/live-test.ts <test campaign id> [--apply]');
  // A preload or inspector could read the key, so no Node flags at all, as in scripts/net/cert-lib.ts.
  if (process.env.NODE_OPTIONS || process.execArgv.length > 0) throw new Error('Refusing to run with NODE_OPTIONS or a Node flag set.');
  const risky = riskyEnvironment();
  if (risky) throw new Error(`Refusing to run: ${risky}`);
  const { devEnvValue } = await import('../lib/dev-env.ts');
  const key = devEnvValue('MAILCHIMP_API_KEY');
  process.exitCode = await liveTestJob({ key, cfg: loadMailchimpConfig(), campaignId: ids[0]!, wholeListSend: localCampaignId(WHOLE_LIST_SEND_NAME), apply, now: Date.now, print: (l) => console.log(l) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Failed.');
    process.exitCode = 1;
  });
}
