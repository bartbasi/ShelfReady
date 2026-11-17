// The fish email worker: one task at a time, in the server process, so two pieces of work never
// change the fish email at once.
//
// A task is either an invoice run's price change (kind run, made when Square confirmed the run's
// prices) or a check with no invoice (kind check: 6pm on Sun, Tue and Thu, and 6am on fish days).
// Both do the same thing, by Bart's rules (src/mailchimp/target.ts): make sure the one fish email
// for the next fish day is ready, named "Fish Email YYYYMMDD", with the date line at the top and
// the right prices: every held invoice change not yet in an email, and the register price where
// the email drifted from it (src/mailchimp/register.ts). Bart, November 10:
// - ShelfReady keeps its email for each fish day by Mailchimp id (mailchimp_fish_days), even while
//   staff have it unscheduled as a draft, and never makes a second one for that day;
// - while staff have it unscheduled, changes are held; the 6:00am check puts them in and schedules
//   it for 8:00am;
// - at 8:15am a sent check confirms it went out, or raises a red alert.
//
// Changing a scheduled campaign means unschedule, edit, then schedule again. Once ShelfReady has
// unscheduled it (or made a copy), it must be scheduled again whatever else fails: if the edit
// fails it is scheduled as it stands with a red alert (Bart, November 9); scheduling is tried, then
// tried once more, and if it still fails the task needs a person and the home page shows a red
// alert. A missed email is the worst outcome; two emails for one day is the next worst, so:
// - before making a copy, ShelfReady first takes up a copy or unscheduled email it left unfinished
//   for that same day, known by id from its own records;
// - while another task's red alert for that day is not cleared, it never makes a copy for that day:
//   a person may be scheduling the one left behind;
// - it never unschedules an email less than the safe margin before it sends (Bart's cutoff: 60
//   minutes). A run's prices then go into the next fish day's email, once this one has gone.
// - a check guards one fish day, fixed when it is queued. If that day comes too close before the
//   check can finish, it raises a red alert; it never quietly works on a later day instead.
//
// Safe on a lost answer and on a restart:
// - each step reads the campaign back by id before and after it acts; title, content, unschedule
//   and schedule are the same request every time, so doing one again changes nothing;
// - a copy (replicate) is the only call that is not: every copy is stored before it is asked
//   for. If the answer is lost, ShelfReady looks for the copy among the drafts on the list: the
//   source's title with any " (copy NN)" left off (Mailchimp numbers copies its own way), made
//   since the call began, and with exactly the source's HTML. One found: it is used. More than
//   one: a person decides. None: ShelfReady looks again two minutes later, and only when both
//   looks find nothing does it count the copy as not made.
// - a task still marked running after 15 minutes raises a red alert (every call times out in 30
//   seconds and each step saves its progress, so it is stuck);
// - nothing is ever deleted.

import { appendAudit, SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import { MailchimpError, MIN_LEAD_MS, type Campaign, type MailchimpApi } from './client.ts';
import type { MailchimpConfig } from './config.ts';
import { addDays, dateLineText, dueCheckSlot, dueCutoffCheck, dueSentCheck, fishTitle, localParts, localToUtc, mailchimpTime, missedCheckSlots, sameMorning, weekdayOf } from './days.ts';
import { centsText, editEmail, foldKey, parseRows, verifyEmail } from './html.ts';
import type { FishMatches } from './matches.ts';
import { findDrift, type RegisterBook } from './register.ts';
import { dayText, fishCampaigns, unitCheck } from './plan.ts';
import {
  addAlertNote,
  addCheckTask,
  addMissedCheck,
  claimTask,
  copiesFor,
  hasSlot,
  heldFor,
  lastTick,
  markHeldApplied,
  setRowCount,
  openRedWithCampaign,
  ownUnfinished,
  queuedTasks,
  raiseAlert,
  requeueRunning,
  setLastTick,
  settleCopy,
  staleRunning,
  startCopy,
  track,
  trackedFor,
  updateTask,
  type AlertLevel,
  type HeldRow,
  type MailchimpTask,
  type TaskProgress,
  type TaskResult,
  type TaskState,
} from './store.ts';
import { campaignLabel, isFishEmail, selectTarget } from './target.ts';

export interface WorkerLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  warn?(obj: object, msg: string): void;
}

export interface WorkerDeps {
  db: Db;
  cfg: MailchimpConfig;
  /** A client built from the key in settings. Throws MailchimpError('setup') when it cannot. */
  api: () => MailchimpApi;
  now: () => number;
  log: WorkerLog;
  /** Start work as soon as it is queued. Default true. Tests turn it off and call drain. */
  auto?: boolean;
  /** The confirmed matches of email rows to Square items, for the drift check. */
  matches?: () => FishMatches;
  /**
   * The register prices, or null when this install has none it may use for the live email (in
   * Phase 1, only with the sandbox test setting). Without them, drift is not checked.
   */
  register?: () => Promise<RegisterBook | null>;
  /** The big-change limit in percent from settings (Bart, November 7: 30). A larger drift fix waits for a person. */
  driftPercent?: () => number;
}

export interface MailchimpWorker {
  kick(): void;
  /** Runs every task that is due now. For tests. */
  drain(): Promise<void>;
  stop(): Promise<void>;
  /** Called once at start: puts tasks a restart cut short back in the queue. */
  recover(): void;
  /**
   * Called at start and on every tick, only when the checks run (Mailchimp writes on): records a
   * red alert for each check that could not run while ShelfReady was off or the PC slept, for the
   * latest fish day only, and moves the clock on.
   */
  catchUp(): void;
  /** Adds the check that is due now, if any, flags stuck tasks, and starts work. Called every minute. */
  tick(): void;
}

/** A lost copy is looked for twice, this far apart, before it counts as not made. */
export const LOOK_AGAIN_MS = 2 * 60_000;
/** A task that could not reach Mailchimp before changing anything tries again this often, this many times. */
export const RETRY_MS = 5 * 60_000;
export const MAX_TRIES = 3;
/** The sent check looks at a scheduled email again this long after its send time. */
export const SENT_GRACE_MS = 15 * 60_000;
/** An email that went to fewer than this share of the last regular fish email's people is a red alert. */
export const RECIPIENT_FLOOR = 0.7;
/** Of the rows the tracked email had when first read, at least this share must still be there to schedule it. */
export const ROWS_FLOOR = 0.5;
/** A campaign under another name with at least this many fish rows counts as a fish email. */
export const FISH_ROWS_MIN = 5;
/** A task marked running longer than this is stuck. */
export const STUCK_MS = 15 * 60_000;

/** Ends a task's work: the state, the alert, the words, and what was done. */
class Finish {
  state: TaskState;
  alert: AlertLevel;
  message: string;
  constructor(state: TaskState, alert: AlertLevel, message: string) {
    this.state = state;
    this.alert = alert;
    this.message = message;
  }
}

/** Puts a task back in the queue until a time. */
class Wait {
  until: number;
  message: string;
  constructor(until: number, message: string) {
    this.until = until;
    this.message = message;
  }
}

function errText(err: unknown): string {
  return err instanceof MailchimpError ? err.message : 'Something went wrong while talking to Mailchimp.';
}

/** A title with Mailchimp's " (copy NN)" left off: copies of copies are numbered afresh. */
export function baseTitle(title: string): string {
  return title.replace(/ \(copy \d+\)$/, '');
}

export function createMailchimpWorker(deps: WorkerDeps): MailchimpWorker {
  const { db, cfg, now, log } = deps;
  const tz = cfg.timeZone;
  const margin = cfg.safeMarginMinutes * 60_000;
  let current: Promise<void> | null = null;
  let stopped = false;

  function hhmm(ms: number): string {
    const l = localParts(ms, cfg.timeZone);
    const h = l.hour % 12 === 0 ? 12 : l.hour % 12;
    return `${h}:${String(l.minute).padStart(2, '0')}${l.hour < 12 ? 'am' : 'pm'}`;
  }

  async function lookForLostCopy(task: MailchimpTask, api: MailchimpApi, p: TaskProgress, red: (m: string) => Finish): Promise<Finish | Wait | null> {
    const asking = copiesFor(db, task.id).find((c) => c.state === 'asking');
    if (!asking) return null;
    const drafts = await api.listCampaigns({ listId: cfg.list.id, status: 'save', sortField: 'create_time', count: 50 });
    const like = drafts.filter((d) => baseTitle(d.title) === baseTitle(asking.sourceTitle) && d.listId === cfg.list.id && d.createTime !== null && d.createTime >= asking.startedAt - 60_000);
    const found: Campaign[] = [];
    if (like.length) {
      // A copy holds exactly the source's HTML. A draft that does not is not ShelfReady's copy.
      const source = await api.getContent(asking.sourceId);
      for (const d of like) if ((await api.getContent(d.id)) === source) found.push(d);
    }
    if (found.length > 1) {
      return red(`Mailchimp's answer to a copy of "${asking.sourceTitle}" was lost, and ${found.length} drafts look like that copy: ${found.map((f) => campaignLabel(f)).join(', ')}. ShelfReady stopped so it does not schedule the wrong one. Schedule one fish email by hand, then clear this alert.`);
    }
    if (found.length === 1) {
      settleCopy(db, asking.id, { state: 'made', campaignId: found[0]!.id, looks: asking.looks + 1 }, now());
      p.mode = 'copy';
      p.targetId = found[0]!.id;
      updateTask(db, task.id, { progress: p }, now());
      appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.copy_found', entityType: 'mailchimp_campaign', entityId: found[0]!.id, runId: task.runId ?? undefined, details: { task: task.id, source: asking.sourceId } }, now());
      return null;
    }
    if (asking.looks < 1) {
      settleCopy(db, asking.id, { looks: asking.looks + 1 }, now());
      return new Wait(now() + LOOK_AGAIN_MS, 'Mailchimp did not answer a copy. ShelfReady looks again in two minutes before doing anything else.');
    }
    settleCopy(db, asking.id, { state: 'not_made', looks: asking.looks + 1 }, now());
    appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.copy_not_made', entityType: 'mailchimp_campaign', entityId: asking.sourceId, runId: task.runId ?? undefined, details: { task: task.id } }, now());
    return null;
  }

  /**
   * The 8:15am check: did the fish day's email go out? Reads only. An email still scheduled for a
   * time not yet passed, or passed less than the grace time ago, is looked at again then: staff
   * sometimes schedule at 8:15. An email sent to far fewer people than the last regular fish email
   * is a red alert too. Words say "check Mailchimp first", since a person may already have acted.
   */
  async function sentCheck(task: MailchimpTask, api: MailchimpApi, p: TaskProgress, result: TaskResult): Promise<Finish | Wait> {
    const day = p.guardDay!;
    result.day = day;
    const red = (msg: string): Finish => new Finish('needs_person', 'red', msg);
    const later = (c: Campaign): Wait | null => {
      if (c.status !== 'schedule' || c.sendTime === null || now() - c.sendTime >= SENT_GRACE_MS) return null;
      return new Wait(Math.max(now() + 60_000, c.sendTime + SENT_GRACE_MS), `${campaignLabel(c)} is scheduled for ${hhmm(c.sendTime)}. ShelfReady looks again 15 minutes after that.`);
    };
    const campaigns = await fishCampaigns(api, cfg);
    const fish = campaigns.filter((c) => isFishEmail(c, cfg));
    const wentToday = fish.filter((c) => (c.status === 'sent' || c.status === 'sending') && c.sendTime !== null && localParts(c.sendTime, tz).day === day);
    // The last regular fish email before this day, sent to the whole list, for the recipient count.
    const before = fish
      .filter((c) => c.status === 'sent' && !c.segmented && c.sendTime !== null && localParts(c.sendTime, tz).day < day)
      .sort((x, y) => y.sendTime! - x.sendTime!)[0];
    const fewer = (c: Campaign): string | null => {
      // While it is still sending, emails_sent is only part way: use the recipient count.
      const got = c.status === 'sending' ? c.recipientCount : (c.emailsSent ?? c.recipientCount);
      const usual = before ? (before.emailsSent ?? before.recipientCount) : null;
      if (got === null || usual === null || usual === 0 || got >= usual * RECIPIENT_FLOOR) return null;
      return `${campaignLabel(c)} went to ${got} people, far fewer than the ${usual} the last fish email (${before!.id}) went to${c.segmented ? ', and it was sent to a segment' : ''}. Check Mailchimp first: the list or segment may be wrong. Then clear this alert.`;
    };
    if (wentToday.length > 1) {
      return red(`More than one fish email went out on ${dayText(day)}: ${wentToday.map((c) => campaignLabel(c)).join(', ')}. Check Mailchimp first, then clear this alert.`);
    }
    const tracked = trackedFor(db, day);
    if (tracked) {
      let c: Campaign;
      try {
        c = await api.getCampaign(tracked.campaignId);
      } catch (err) {
        if (err instanceof MailchimpError && err.kind === 'refused' && err.status === 404) return red(`The ${dayText(day)} fish email (${tracked.campaignId}) is gone from Mailchimp. Check Mailchimp first: if no fish email went out, a person decides what to do. Then clear this alert.`);
        throw err;
      }
      result.campaignId = c.id;
      result.campaignTitle = c.title;
      if (c.status === 'sent' || c.status === 'sending') {
        const few = fewer(c);
        return few ? red(few) : new Finish('done', '', `${campaignLabel(c)} went out.`);
      }
      const wait = later(c);
      if (wait) return wait;
      return red(`The ${dayText(day)} fish email ${campaignLabel(c)} has not gone out: Mailchimp shows it as "${c.status}"${c.sendTime !== null ? ` for ${hhmm(c.sendTime)}` : ''}. Check Mailchimp first, then a person decides what to do. Then clear this alert.`);
    }
    // Not tracked (staff made it by hand): a fish email sent that day counts.
    if (wentToday.length === 1) {
      const few = fewer(wentToday[0]!);
      return few ? red(few) : new Finish('done', '', `${campaignLabel(wentToday[0]!)} went out.`);
    }
    const pending = fish.filter((c) => c.status === 'schedule' && c.sendTime !== null && localParts(c.sendTime, tz).day === day).sort((x, y) => x.sendTime! - y.sendTime!);
    for (const c of pending) {
      const wait = later(c);
      if (wait) return wait;
    }
    return red(`No fish email went out on ${dayText(day)}${pending.length ? `; ${pending.map((c) => campaignLabel(c)).join(', ')} still shows as scheduled` : ''}. Check Mailchimp first, then a person decides what to do. Then clear this alert.`);
  }

  /**
   * Campaigns scheduled to the fish list on a fish day's morning, sorted: fish-like ones (named
   * like a fish email, or holding fish rows under another name, a replacement staff made) and
   * others (a holiday promotion, say). Only fish-like ones count as a second fish email.
   */
  async function morningOn(api: MailchimpApi, campaigns: readonly Campaign[], day: string): Promise<{ fishLike: Campaign[]; others: Campaign[] }> {
    const morning = [...new Map(campaigns.filter((c) => c.listId === cfg.list.id && c.status === 'schedule' && c.sendTime !== null && c.sendTime >= now() && sameMorning(c.sendTime, day, tz)).map((c) => [c.id, c])).values()];
    const fishLike: Campaign[] = [];
    const others: Campaign[] = [];
    for (const c of morning) {
      if (c.title.startsWith(cfg.titlePrefix) || parseRows(await api.getContent(c.id)).length >= FISH_ROWS_MIN) fishLike.push(c);
      else others.push(c);
    }
    return { fishLike, others };
  }

  /**
   * The 7:00am cutoff check: reads only. No fish email scheduled for that morning is a red alert,
   * and so is a second one: a fish email under any name. Any other campaign that morning is a
   * warning only.
   */
  async function cutoffCheck(task: MailchimpTask, api: MailchimpApi, p: TaskProgress, result: TaskResult): Promise<Finish> {
    const day = p.guardDay!;
    result.day = day;
    const { fishLike, others } = await morningOn(api, await fishCampaigns(api, cfg), day);
    const tracked = trackedFor(db, day);
    const list = (cs: Campaign[]): string => cs.map((c) => `${campaignLabel(c)} at ${hhmm(c.sendTime!)}`).join(', ');
    if (fishLike.length > 1) {
      return new Finish('needs_person', 'red', `More than one fish email is scheduled for the morning of ${dayText(day)}: ${list(fishLike)}. Customers would get both. Check Mailchimp first and unschedule the extra one, then clear this alert.`);
    }
    if (tracked && fishLike.length === 1 && fishLike[0]!.id !== tracked.campaignId) {
      return new Finish('needs_person', 'red', `${campaignLabel(fishLike[0]!)} is scheduled for the morning of ${dayText(day)}, but ShelfReady's email for that day is ${tracked.campaignId}. Check Mailchimp first: make sure only one fish email goes, then clear this alert.`);
    }
    if (!fishLike.length) {
      return new Finish('needs_person', 'red', `No fish email is scheduled for ${hhmm(p.guardAt ?? now())} on ${dayText(day)}. Check Mailchimp.${others.length ? ` Also scheduled that morning: ${list(others)}.` : ''}`);
    }
    if (others.length) return new Finish('done', 'warn', `${campaignLabel(fishLike[0]!)} is scheduled for the morning of ${dayText(day)}. Another campaign also goes to the fish list that morning: ${list(others)}. Make sure that is meant.`);
    return new Finish('done', '', `${campaignLabel(fishLike[0]!)} is scheduled for the morning of ${dayText(day)}.`);
  }

  /** Every change for the email: held invoice prices, then the register price where it differs. */
  async function changesFor(day: string, html: string, result: TaskResult): Promise<{ edits: Array<{ key: string; toCents: number; why: 'invoice' | 'drift' }>; held: HeldRow[] }> {
    const held = heldFor(db, day, now());
    for (const r of held.tooOld) result.notChanged.push({ key: r.rowKey, why: `an invoice change from over three weeks ago was not put in on its own. Check it by hand (${centsText(r.toCents)}). An admin can set it aside on the home page.` });
    const units = unitCheck(html, held.rows.map((r) => ({ key: r.rowKey, itemId: r.itemId, variationId: r.variationId, label: r.label, toCents: r.toCents, perPound: r.perPound })), cfg);
    result.notChanged.push(...units.notChanged);
    const edits = new Map<string, { key: string; toCents: number; why: 'invoice' | 'drift' }>();
    for (const e of units.edits) edits.set(foldKey(e.key), { key: e.key, toCents: e.toCents, why: 'invoice' });
    let book: RegisterBook | null = null;
    let matches: FishMatches | null = null;
    try {
      book = deps.register ? await deps.register() : null;
      matches = book && deps.matches ? deps.matches() : null;
    } catch (err) {
      result.problems.push(`The register prices could not be read, so drift was not checked: ${err instanceof Error && err.name === 'MatchesError' ? err.message : 'something went wrong.'}`);
    }
    if (book && matches) {
      // The register is the price now: it wins over an older invoice change for the same row.
      const drift = findDrift(html, matches, book, cfg, { percent: deps.driftPercent?.() ?? 30, maxCount: cfg.driftMaxPerEdit });
      result.notChanged.push(...drift.forPerson);
      for (const f of drift.fixes) {
        const prior = edits.get(foldKey(f.key));
        edits.set(foldKey(f.key), { key: f.key, toCents: f.toCents, why: prior && prior.toCents === f.toCents ? 'invoice' : 'drift' });
      }
      result.notCompared = drift.notCompared;
    }
    return { edits: [...edits.values()], held: held.fresh };
  }

  /** The held rows the email now holds: each row key changed, or already at its price. Refused ones stay held. */
  function heldTaken(held: readonly HeldRow[], edit: { changes: ReadonlyArray<{ key: string }>; same: readonly string[] }): number[] {
    const taken = new Set([...edit.changes.map((c) => foldKey(c.key)), ...edit.same.map((k) => foldKey(k))]);
    return held.filter((r) => taken.has(foldKey(r.rowKey))).map((r) => r.id);
  }

  async function work(task: MailchimpTask, api: MailchimpApi, p: TaskProgress, result: TaskResult, ctx: { asked: boolean }): Promise<Finish | Wait> {
    const save = (): void => updateTask(db, task.id, { progress: p }, now());
    const isCheck = task.kind === 'check';
    const red = (msg: string): Finish => new Finish('needs_person', 'red', msg);
    if (isCheck && p.purpose === 'sent') return sentCheck(task, api, p, result);
    if (isCheck && p.purpose === 'cutoff') return cutoffCheck(task, api, p, result);

    // A check guards one fish day. Too close to it before its email was even found: say so, and
    // do not move on to a later day. (With its email found, the cutoff below leaves it alone.)
    if (isCheck && p.guardDay && p.guardAt !== undefined && p.targetId === undefined && p.guardAt - now() < margin) {
      return red(`The check for the ${dayText(p.guardDay)} fish email could not finish before the cutoff (${hhmm(p.guardAt - margin)}). Make sure that email is scheduled or went out, then clear this alert.`);
    }

    // 0. A copy whose answer was lost: look for it before anything else.
    const lost = await lookForLostCopy(task, api, p, red);
    if (lost) return lost;
    if (p.targetId && p.mode === 'copy' && p.day && !trackedFor(db, p.day)) track(db, p.day, p.targetId, 'copied', task.id, now());

    // 1. The target: the one campaign for the next fish day.
    let target: Campaign;
    if (p.targetId) {
      target = await api.getCampaign(p.targetId);
    } else {
      const campaigns = await fishCampaigns(api, cfg);
      // An invoice while a fish email is about to go (inside the cutoff) or sending: its prices are
      // held, and go into the next fish day's email, made later from the one going now, so staff
      // edits in it are kept.
      if (!isCheck) {
        const going = campaigns.filter((c) => isFishEmail(c, cfg) && (c.status === 'sending' || (c.status === 'schedule' && c.sendTime !== null && c.sendTime - now() < margin)));
        if (going.length) return new Finish('done', '', 'A fish email is about to go, so these prices are held for the next fish day\'s email.');
      }
      const last = await lastOwnSent(db, cfg, api, now());
      const sel = selectTarget(campaigns, now(), cfg, { source: last.source });
      // Only matters when a copy is needed: a tracked or scheduled email for the day needs no source.
      if (last.problem && sel.kind === 'copy' && !trackedFor(db, sel.send.day)) return red(last.problem);
      if (isCheck && p.guardDay && sel.send.day !== p.guardDay) {
        return red(`The check for the ${dayText(p.guardDay)} fish email could not finish before the cutoff. Make sure that email is scheduled or went out, then clear this alert.`);
      }
      p.day = sel.send.day;
      p.sendAt = sel.send.at;
      result.day = sel.send.day;
      save();
      const tracked = trackedFor(db, p.day);
      if (tracked) {
        // ShelfReady has its email for this day, by id, whatever its state. Never a second one.
        let c: Campaign;
        try {
          c = await api.getCampaign(tracked.campaignId);
        } catch (err) {
          if (err instanceof MailchimpError && err.kind === 'refused' && err.status === 404) {
            return red(`The ${dayText(p.day)} fish email (${tracked.campaignId}) is gone from Mailchimp. ShelfReady will not make a second one for that day. Make sure one is scheduled by hand, then clear this alert.`);
          }
          throw err;
        }
        // Any other fish email scheduled, and any campaign scheduled to the fish list that morning
        // that is a fish email under another name (it holds fish rows), would go out beside
        // ShelfReady's: red. Another campaign that morning (a promotion) is only a warning.
        const morning = await morningOn(api, campaigns.filter((x) => x.id !== c.id), p.day);
        const others = [
          ...new Map(
            [...campaigns.filter((x) => isFishEmail(x, cfg) && x.status === 'schedule' && x.id !== c.id && x.sendTime !== null && x.sendTime - now() >= margin), ...morning.fishLike].map((x) => [x.id, x]),
          ).values(),
        ];
        if (morning.others.length) result.problems.push(`Another campaign also goes to the fish list that morning: ${morning.others.map((x) => `${campaignLabel(x)} at ${hhmm(x.sendTime!)}`).join(', ')}. Make sure that is meant.`);
        if (others.length) {
          return red(`Another fish email is scheduled besides ShelfReady's ${campaignLabel(c)} for ${dayText(p.day)}: ${others.map((x) => campaignLabel(x)).join(', ')}. ShelfReady changed nothing. Keep one, then clear this alert.`);
        }
        if (c.listId !== cfg.list.id) return red(`${campaignLabel(c)} is not on the fish list. ShelfReady changed nothing.`);
        if (c.status === 'sent' || c.status === 'sending') return new Finish('done', 'warn', `${campaignLabel(c)}, the ${dayText(p.day)} email, already went out.`);
        if (c.status === 'schedule') {
          p.mode = 'edit';
          p.scheduleAt = c.sendTime!;
        } else if (c.status === 'save' || c.status === 'paused') {
          const own = ownUnfinished(db, p.day, task.id).find((o) => o.campaignId === c.id);
          if (own) {
            // ShelfReady itself left it unfinished (a failed schedule): schedule it now. The same
            // campaign, so never a second email; its open alert then says it was scheduled.
            p.mode = own.mode;
            p.unscheduled = true;
            p.scheduleAt = own.scheduleAt ?? sel.send.at;
            p.tookUpFrom = own.taskId;
            appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.take_up', entityType: 'mailchimp_campaign', entityId: c.id, runId: task.runId ?? undefined, details: { task: task.id, from: own.taskId, day: p.day } }, now());
          } else if (isCheck && p.scheduleDrafts) {
            // 6:00am on the fish day, and staff still have it unscheduled: the held changes go in
            // and it is scheduled for the send time (Bart, November 10).
            p.mode = 'edit';
            p.unscheduled = true;
            p.drafted = true;
            p.scheduleAt = sel.send.at;
            appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.schedule_draft', entityType: 'mailchimp_campaign', entityId: c.id, details: { task: task.id, day: p.day } }, now());
          } else {
            // Staff have it unscheduled: hold the changes until they schedule it, or 6:00am.
            result.campaignId = c.id;
            result.campaignTitle = c.title;
            const held = heldFor(db, p.day, now()).rows.length;
            return new Finish('done', result.problems.length ? 'warn' : '', `${result.problems.length ? `${result.problems.join(' ')} ` : ''}Staff have the ${dayText(p.day)} email ${campaignLabel(c)} unscheduled. ${held ? `${held} price ${held === 1 ? 'change is' : 'changes are'} held` : 'Any changes are held'} until they schedule it, or until 6:00am, when ShelfReady puts them in and schedules it.`);
          }
        } else {
          return red(`${campaignLabel(c)} is in a state ShelfReady does not know (${c.status}). It changed nothing.`);
        }
        p.targetId = c.id;
        save();
        target = c;
      } else {
        if (sel.kind === 'stop') return red(sel.reason);
        if (sel.kind === 'edit') {
          // Staff scheduled one for this day: ShelfReady takes it on, and keeps it by id.
          track(db, p.day, sel.campaign.id, 'adopted', task.id, now());
          p.mode = 'edit';
          p.targetId = sel.campaign.id;
          p.scheduleAt = sel.campaign.sendTime!;
          save();
          target = sel.campaign;
        } else {
          // No copy while an open red alert for this day names a campaign a person may be fixing.
          const blocked = openRedWithCampaign(db, p.day, task.id);
          if (blocked.length) {
            return red(`An open alert for the ${dayText(p.day)} fish email names ${blocked.join(', ')}, and a person may be scheduling it by hand, so ShelfReady made no copy. Make sure one fish email is scheduled for that day, then clear both alerts.`);
          }
          result.sourceId = sel.source.id;
          const copyId = startCopy(db, task.id, sel.source, now());
          let made: Campaign;
          try {
            made = await api.replicate(sel.source.id);
          } catch (err) {
            if (err instanceof MailchimpError && err.kind === 'unknown') return new Wait(now(), 'Mailchimp did not answer a copy. ShelfReady is looking for it before anything else.');
            settleCopy(db, copyId, { state: 'not_made' }, now());
            throw err;
          }
          settleCopy(db, copyId, { state: 'made', campaignId: made.id }, now());
          track(db, p.day, made.id, 'copied', task.id, now());
          appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.copy', entityType: 'mailchimp_campaign', entityId: made.id, runId: task.runId ?? undefined, details: { task: task.id, source: sel.source.id, sourceTitle: sel.source.title, day: p.day } }, now());
          p.mode = 'copy';
          p.targetId = made.id;
          p.scheduleAt = sel.send.at;
          save();
          target = await api.getCampaign(made.id);
        }
      }
    }
    if (p.day === undefined || p.sendAt === undefined) return red('ShelfReady lost track of the send day for this fish email. Check Mailchimp, then clear this alert.');
    if (p.scheduleAt === undefined) p.scheduleAt = p.sendAt;
    result.campaignId = target.id;
    result.campaignTitle = target.title;
    result.mode = p.mode ?? 'none';
    result.day = p.day;
    result.scheduledFor = `${dayText(p.day)}, ${hhmm(p.scheduleAt)}`;
    if (target.listId !== cfg.list.id) return red(`${campaignLabel(target)} is not on the fish list. ShelfReady changed nothing more.`);
    if (target.status === 'sent' || target.status === 'sending') {
      return new Finish('done', 'warn', `${campaignLabel(target)} went out before ShelfReady could change it. It went as Mailchimp had it.`);
    }
    if (target.status === 'schedule' && p.scheduled) return new Finish('done', isCheck && p.mode === 'copy' ? 'note' : '', finishedText(p, result));

    // 2. What to change: only prices, the date line and the name. Staff's other text stays.
    const title = fishTitle(cfg.titlePrefix, p.day);
    const html = await api.getContent(target.id);
    // Never trust the id alone: the campaign must still be the fish email. A tracked email staff
    // reused for something else is left alone with a red alert, never scheduled.
    const rowCount = parseRows(html).length;
    if (rowCount === 0) return red(`${campaignLabel(target)} has no fish rows. It may have been reused for something else, so ShelfReady left it alone and scheduled nothing. Check Mailchimp, then clear this alert.`);
    if (!target.title.startsWith(cfg.titlePrefix)) return red(`${campaignLabel(target)} is no longer named like a fish email. It may have been reused for something else, so ShelfReady left it alone and scheduled nothing. Check Mailchimp, then clear this alert.`);
    const mine = trackedFor(db, p.day);
    if (mine && mine.campaignId === target.id) {
      if (mine.rowCount === null) setRowCount(db, p.day, rowCount);
      else if (rowCount < mine.rowCount * ROWS_FLOOR) {
        return red(`${campaignLabel(target)} now has ${rowCount} fish rows, not the ${mine.rowCount} it had. It may have been reused for something else, so ShelfReady left it alone and scheduled nothing. Check Mailchimp, then clear this alert.`);
      }
    }
    const { edits: wanted, held } = await changesFor(p.day, html, result);
    const edit = editEmail(html, wanted.map((w) => ({ key: w.key, toCents: w.toCents })), { units: cfg.units, dateLine: cfg.dateLine, dateText: dateLineText(p.day) });
    result.notChanged.push(...edit.refused);
    if (edit.dateLineProblem) result.problems.push(edit.dateLineProblem);
    const needTitle = target.title !== title;
    const needHtml = edit.html !== html;
    if (needTitle) result.title = { from: target.title, to: title };
    if (edit.dateLine && edit.dateLine.from !== edit.dateLine.to) result.dateLine = { from: edit.dateLine.from, to: edit.dateLine.to };
    const why = new Map(wanted.map((w) => [foldKey(w.key), w.why]));

    if (target.status === 'schedule') {
      if (!needTitle && !needHtml) {
        p.scheduled = true;
        save();
        markHeldApplied(db, heldTaken(held, edit), p.day, now());
        // Nothing to write, but a refused held change or a note above still needs a person to see it.
        return new Finish('done', result.problems.length || result.notChanged.length ? 'warn' : '', finishedText(p, result));
      }
      // Never unschedule inside the cutoff: the email goes as it is, and held changes go into the
      // next fish day's email.
      const sendsAt = target.sendTime ?? p.scheduleAt;
      if (sendsAt - now() < margin) {
        return new Finish('done', '', `${campaignLabel(target)} sends at ${hhmm(sendsAt)}, inside the cutoff, so ShelfReady left it as it is.${wanted.length ? ' Its price changes go into the next fish day\'s email.' : ''}`);
      }
      // Unschedule. From the moment it is asked for, the email must be scheduled again.
      p.unscheduling = true;
      ctx.asked = true;
      save();
      target = await unscheduleChecked(api, target.id);
      if (target.status === 'schedule') {
        p.unscheduling = false;
        save();
        return new Finish('stopped', 'warn', `ShelfReady could not unschedule ${campaignLabel(target)}, so it changed nothing. The email goes out as it was. ${wanted.length ? 'Its price changes stay held for the next try.' : ''}`.trim());
      }
      if (target.status === 'sent' || target.status === 'sending') return new Finish('done', 'warn', `${campaignLabel(target)} went out before ShelfReady could change it. It went as Mailchimp had it.`);
      p.unscheduled = true;
      save();
    } else if (target.status === 'save' || target.status === 'paused') {
      // A draft ShelfReady may schedule: its own copy, one it unscheduled (confirmed), or one the
      // 6:00am check took on. Anything else became unscheduled by a person: changes are held.
      if (p.mode === 'edit' && !p.unscheduled) {
        if (p.unscheduling) {
          return red(`${campaignLabel(target)} is not scheduled. ShelfReady asked to unschedule it but never saw Mailchimp confirm it, so a person may have unscheduled it. ShelfReady left it alone. Check Mailchimp, then clear this alert.`);
        }
        return new Finish('done', '', `Staff unscheduled ${campaignLabel(target)} while ShelfReady worked on it. Its changes are held until they schedule it, or until 6:00am.`);
      }
    } else {
      return red(`${campaignLabel(target)} is in a state ShelfReady does not know (${target.status}). It changed nothing more.`);
    }

    // 3. Edit. A failure here does not stop the schedule below.
    let edited = true;
    try {
      if (needTitle) await setTitleChecked(api, target, title);
      if (needHtml) {
        await putContentChecked(api, target.id, edit.html, { dateText: edit.dateLine ? edit.dateLine.to : null, prices: edit.changes.map((c) => ({ key: c.key, toText: c.toText })), dateLineClass: cfg.dateLine.class });
      }
    } catch (err) {
      edited = false;
      result.problems.push(`The edit did not finish: ${errText(err)}`);
    }
    if (edited) {
      result.changes = edit.changes.map((c) => ({ key: c.key, from: c.fromText, to: c.toText, before: c.before, after: c.after, why: why.get(foldKey(c.key)) ?? 'invoice' }));
      appendAudit(
        db,
        SYSTEM_ACTOR,
        {
          action: 'mailchimp.edit',
          entityType: 'mailchimp_campaign',
          entityId: target.id,
          runId: task.runId ?? undefined,
          details: { task: task.id, kind: task.kind, title: result.title, dateLine: result.dateLine, prices: edit.changes.map((c) => ({ row: c.key, from: c.fromText, to: c.toText, why: why.get(foldKey(c.key)) ?? 'invoice' })) },
        },
        now(),
      );
    } else {
      result.title = null;
      result.dateLine = null;
    }

    // 4. Schedule, and once more if that fails.
    const at = p.scheduleAt;
    if (at - now() < MIN_LEAD_MS) {
      return red(`It is too late to schedule ${campaignLabel(target)} for ${result.scheduledFor}. It is NOT scheduled. Send it by hand in Mailchimp now, then clear this alert.`);
    }
    let ok = await scheduleChecked(api, target.id, at);
    if (!ok) ok = await scheduleChecked(api, target.id, at);
    if (!ok) {
      appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.schedule_failed', entityType: 'mailchimp_campaign', entityId: target.id, runId: task.runId ?? undefined, details: { task: task.id, at: mailchimpTime(at) } }, now());
      return red(`The fish email for ${dayText(p.day)} is NOT scheduled. ShelfReady tried twice. Schedule ${campaignLabel(target)} by hand in Mailchimp for ${hhmm(at)}, then clear this alert.`);
    }
    p.scheduled = true;
    save();
    appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.schedule', entityType: 'mailchimp_campaign', entityId: target.id, runId: task.runId ?? undefined, details: { task: task.id, at: mailchimpTime(at) } }, now());
    if (p.tookUpFrom !== undefined) {
      const by = task.kind === 'check' && task.slot ? `the ${task.slot.replace('T', ' ')} check` : 'a later task';
      addAlertNote(db, p.tookUpFrom, `Update: ShelfReady scheduled ${campaignLabel(target)} for ${result.scheduledFor} at ${by}. Do not make or schedule another; check it, then clear this alert.`, now());
    }
    result.campaignTitle = edited && needTitle ? title : target.title;
    // Bart, November 9: scheduled anyway, with a red alert, so a person fixes it before it goes.
    if (!edited) return red(`${campaignLabel(target)} is scheduled for ${result.scheduledFor}, but its prices, name or date line did not change. ${result.problems[0] ?? ''} Fix it by hand in Mailchimp before it goes, then clear this alert.`.trim());
    markHeldApplied(db, heldTaken(held, edit), p.day, now());
    const drifted = result.changes.some((c) => c.why === 'drift');
    // A held change or a drift fix that could not go in is a warning, for checks as for runs.
    const alert: AlertLevel = result.problems.length || result.notChanged.length ? 'warn' : p.drafted || drifted || (isCheck && (p.mode === 'copy' || needTitle || needHtml)) ? 'note' : '';
    return new Finish('done', alert, finishedText(p, result));
  }

  function finishedText(p: TaskProgress, r: TaskResult): string {
    const what = r.mode === 'copy' ? `ShelfReady copied the last fish email and scheduled it for ${r.scheduledFor}` : `The fish email for ${r.scheduledFor} is scheduled`;
    const bits: string[] = [];
    if (p.drafted) bits.push('staff had left it unscheduled, so ShelfReady put in the held changes and scheduled it at 6:00am');
    const inv = r.changes.filter((c) => c.why !== 'drift');
    const drift = r.changes.filter((c) => c.why === 'drift');
    if (inv.length) bits.push(`${inv.length} ${inv.length === 1 ? 'price changed' : 'prices changed'} from invoices`);
    if (drift.length) bits.push(`set to the register price: ${drift.map((c) => `${c.key} ${c.from} to ${c.to}`).join('; ')}`);
    if (r.title) bits.push(`named ${r.title.to}`);
    if (r.dateLine) bits.push(`date line set to ${r.dateLine.to}`);
    if (r.mode === 'copy' && !r.changes.length) bits.push('prices kept as they were');
    if (r.notChanged.length) bits.push(`${r.notChanged.length} ${r.notChanged.length === 1 ? 'row' : 'rows'} not changed (see the list)`);
    return `${what}${bits.length ? `: ${bits.join(', ')}` : ', and nothing needed to change'}.${r.problems.length ? ` ${r.problems.join(' ')}` : ''}`;
  }

  async function runOne(task: MailchimpTask): Promise<void> {
    const p: TaskProgress = { ...task.progress };
    const result: TaskResult = { campaignId: p.targetId ?? '', campaignTitle: '', mode: p.mode ?? 'none', day: p.day ?? '', scheduledFor: '', title: null, dateLine: null, changes: [], notChanged: [], problems: [] };
    let outcome: Finish | Wait;
    let api: MailchimpApi;
    const ctx = { asked: false };
    try {
      api = deps.api();
    } catch (err) {
      outcome = new Finish('stopped', task.kind === 'check' ? 'red' : 'warn', `${errText(err)} ${task.kind === 'check' ? 'ShelfReady could not check that a fish email is scheduled.' : 'The fish email prices did not change.'}`);
      return record(task, p, result, outcome);
    }
    try {
      outcome = await work(task, api, p, result, ctx);
    } catch (err) {
      const touched = p.targetId !== undefined || copiesFor(db, task.id).length > 0;
      const tries = (p.tries ?? 0) + 1;
      // Asked to unschedule in this very try (it may have landed), confirmed earlier, or a copy.
      const mustSchedule = !p.scheduled && p.targetId !== undefined && (ctx.asked || p.unscheduled === true || p.mode === 'copy');
      if (err instanceof MailchimpError && err.kind !== 'setup' && !touched && tries < MAX_TRIES) {
        p.tries = tries;
        outcome = new Wait(now() + RETRY_MS, `Mailchimp could not be reached (${errText(err)}). ShelfReady tries again in five minutes.`);
      } else if (mustSchedule) {
        // Past the point of no return: schedule it as it stands, twice if need be, with a red alert.
        const at = p.scheduleAt ?? p.sendAt;
        const inTime = at !== undefined && at - now() >= MIN_LEAD_MS;
        let ok = inTime && (await scheduleChecked(api, p.targetId!, at!));
        if (!ok && inTime) ok = await scheduleChecked(api, p.targetId!, at!);
        if (ok) {
          p.scheduled = true;
          appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.schedule', entityType: 'mailchimp_campaign', entityId: p.targetId!, runId: task.runId ?? undefined, details: { task: task.id, at: mailchimpTime(at!), asItStood: true } }, now());
          outcome = new Finish('needs_person', 'red', `The fish email ${p.targetId} is scheduled, but ShelfReady could not finish changing it: ${errText(err)} Fix its name, date line${task.kind === 'run' ? ' and prices' : ''} by hand in Mailchimp before it goes, then clear this alert.`);
        } else {
          appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.schedule_failed', entityType: 'mailchimp_campaign', entityId: p.targetId!, runId: task.runId ?? undefined, details: { task: task.id } }, now());
          outcome = new Finish('needs_person', 'red', `The fish email may NOT be scheduled. ${errText(err)} Check campaign ${p.targetId} in Mailchimp now and schedule it by hand, then clear this alert.`);
        }
      } else {
        outcome = new Finish('stopped', task.kind === 'check' ? 'red' : 'warn', `${errText(err)} ${task.kind === 'check' ? 'ShelfReady could not make sure a fish email is scheduled. Check Mailchimp.' : 'The fish email prices did not change.'}`);
      }
      if (!(err instanceof MailchimpError)) log.error({ task: task.id, err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp task error');
    }
    record(task, p, result, outcome);
  }

  function record(task: MailchimpTask, p: TaskProgress, result: TaskResult, outcome: Finish | Wait): void {
    if (outcome instanceof Wait) {
      updateTask(db, task.id, { state: 'queued', progress: p, message: outcome.message, notBefore: outcome.until }, now());
      return;
    }
    updateTask(db, task.id, { state: outcome.state, progress: p, result, message: outcome.message, alert: outcome.alert }, now());
    appendAudit(
      db,
      SYSTEM_ACTOR,
      {
        action: `mailchimp.${task.kind}.${outcome.state}`,
        entityType: 'mailchimp_task',
        entityId: task.id,
        runId: task.runId ?? undefined,
        details: { slot: task.slot, campaign: result.campaignId, mode: result.mode, day: result.day, alert: outcome.alert, message: outcome.message, notChanged: result.notChanged.map((n) => n.key) },
      },
      now(),
    );
    log.info({ task: task.id, kind: task.kind, state: outcome.state }, 'mailchimp task finished');
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      let task: MailchimpTask | null;
      try {
        task = claimTask(db, now());
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp worker could not take a task');
        return;
      }
      if (!task) return;
      try {
        await runOne(task);
      } catch (err) {
        log.error({ task: task.id, err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp worker error');
        return;
      }
    }
  }

  const start = (): void => {
    if (current || stopped) return;
    current = loop().finally(() => {
      current = null;
    });
  };

  const worker: MailchimpWorker = {
    kick() {
      if (deps.auto !== false) start();
    },
    async drain() {
      while (!stopped) {
        start();
        if (current) await current;
        const due = db.prepare("SELECT count(*) AS n FROM mailchimp_tasks WHERE state = 'queued' AND not_before <= ?").get(now()) as { n: number };
        if (due.n === 0 || queuedTasks(db) === 0) return;
      }
    },
    async stop() {
      stopped = true;
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
    recover() {
      requeueRunning(db, now());
    },
    catchUp() {
      try {
        // Checks that could not run while ShelfReady was off, and can no longer run in time. Only
        // those guarding the latest fish day: older ones are long past, and one alert is enough.
        const since = lastTick(db);
        const missed = since === null ? [] : missedCheckSlots(Math.max(since, now() - 4 * 86400_000), now(), cfg);
        const latest = missed.reduce((d, m) => (m.guard.day > d ? m.guard.day : d), '');
        {
          for (const m of missed.filter((x) => x.guard.day === latest)) {
            if (hasSlot(db, m.slot)) continue;
            const message = `ShelfReady was off or asleep at the ${m.slot.replace('T', ' ')} check, so it could not make sure the ${dayText(m.guard.day)} fish email was scheduled. Check in Mailchimp that it went out or is scheduled, then clear this alert.`;
            if (addMissedCheck(db, m.slot, m.guard, message, now())) appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.check.missed', entityType: 'mailchimp_task', entityId: m.slot, details: { guardDay: m.guard.day } }, now());
          }
        }
        setLastTick(db, now());
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp missed checks could not be recorded');
      }
    },
    tick() {
      try {
        const slot = dueCheckSlot(now(), cfg);
        if (slot && !hasSlot(db, slot.slot) && addCheckTask(db, slot.slot, { day: slot.guard.day, at: slot.guard.at }, now(), { scheduleDrafts: slot.scheduleDrafts })) log.info({ slot: slot.slot }, 'mailchimp check queued');
        const cut = dueCutoffCheck(now(), cfg);
        if (cut && !hasSlot(db, cut.slot) && addCheckTask(db, cut.slot, { day: cut.day, at: cut.sendAt }, now(), { purpose: 'cutoff' })) log.info({ slot: cut.slot }, 'mailchimp cutoff check queued');
        const sent = dueSentCheck(now(), cfg);
        if (sent && !hasSlot(db, sent.slot) && addCheckTask(db, sent.slot, { day: sent.day, at: sent.sendAt }, now(), { purpose: 'sent' })) log.info({ slot: sent.slot }, 'mailchimp sent check queued');
        for (const t of staleRunning(db, now() - STUCK_MS)) {
          raiseAlert(db, t.id, 'A fish email task has been working for over 15 minutes and seems stuck. Check in Mailchimp that the next fish email is scheduled, then restart ShelfReady.', now());
          appendAudit(db, SYSTEM_ACTOR, { action: 'mailchimp.stuck', entityType: 'mailchimp_task', entityId: t.id, runId: t.runId ?? undefined }, now());
        }
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp check could not be queued');
      }
      // Every minute too, not only at start: a PC that slept through a check (the timer did not
      // fire) is reported when it wakes. It also moves the clock on.
      worker.catchUp();
      worker.kick();
    },
  };
  return worker;
}

/**
 * ShelfReady's own email for the last fish day, when it went out to the whole list: the copy
 * source. Null when there is none (the email was made by hand, or went to a segment). problem:
 * the tracked email went out but is no longer named like a fish email, so it may have been reused
 * for something else: the caller stops with a red alert rather than copy it or another.
 */
export async function lastOwnSent(db: Db, cfg: MailchimpConfig, api: MailchimpApi, now: number): Promise<{ source: Campaign | null; problem: string }> {
  const tz = cfg.timeZone;
  let day = localParts(now, tz).day;
  for (let i = 0; i < 8; i++, day = addDays(day, -1)) {
    if (!cfg.fishDays.includes(weekdayOf(day)) || localToUtc(day, cfg.sendTime, tz) > now) continue;
    const t = trackedFor(db, day);
    if (!t) return { source: null, problem: '' };
    try {
      const c = await api.getCampaign(t.campaignId);
      if (c.status !== 'sent' || c.segmented || c.listId !== cfg.list.id) return { source: null, problem: '' };
      if (!c.title.startsWith(cfg.titlePrefix)) {
        return { source: null, problem: `ShelfReady's email for ${day}, ${campaignLabel(c)}, is no longer named like a fish email, so it will not copy it or any other. Check Mailchimp, make sure one fish email is scheduled for the next fish day, then clear this alert.` };
      }
      return { source: c, problem: '' };
    } catch (err) {
      if (err instanceof MailchimpError && err.kind === 'refused') return { source: null, problem: '' };
      throw err;
    }
  }
  return { source: null, problem: '' };
}

/** Unschedules, reads back, and tries once more if it is still scheduled. Returns the campaign as read. */
export async function unscheduleChecked(api: MailchimpApi, id: string): Promise<Campaign> {
  for (let i = 0; i < 2; i++) {
    try {
      await api.unschedule(id);
    } catch (err) {
      if (err instanceof MailchimpError && err.kind === 'setup') throw err;
      // Refused or lost: the read below says what Mailchimp holds.
    }
    const c = await api.getCampaign(id);
    if (c.status !== 'schedule') return c;
  }
  return api.getCampaign(id);
}

/**
 * Sets the title, sending every other setting a person sees back exactly as read, then reads it
 * back: the title must be new and the subject, sender, reply-to, preview text and to-name the same.
 */
export async function setTitleChecked(api: MailchimpApi, c: Campaign, title: string): Promise<void> {
  if (!c.subjectLine.trim() || !c.fromName.trim() || !c.replyTo.trim()) throw new MailchimpError('setup', 'The email has no subject, sender or reply-to, so ShelfReady did not rename it.');
  const settings = { title, subject_line: c.subjectLine, from_name: c.fromName, reply_to: c.replyTo, preview_text: c.previewText, to_name: c.toName };
  for (let i = 0; i < 2; i++) {
    try {
      await api.setTitle(c.id, settings);
    } catch (err) {
      if (!(err instanceof MailchimpError) || err.kind !== 'unknown') throw err;
    }
    const back = await api.getCampaign(c.id);
    if (back.title === title) {
      const moved = (['subjectLine', 'fromName', 'replyTo', 'previewText', 'toName'] as const).filter((k) => back[k] !== c[k]);
      if (moved.length) throw new MailchimpError('unknown', `Setting the name also changed ${moved.join(', ')}. Check them in Mailchimp.`);
      return;
    }
  }
  throw new MailchimpError('unknown', 'The new name did not stick in Mailchimp.');
}

/** Puts the HTML and reads it back: the date line and every changed price must show. */
export async function putContentChecked(api: MailchimpApi, id: string, html: string, expected: Parameters<typeof verifyEmail>[1]): Promise<void> {
  for (let i = 0; i < 2; i++) {
    try {
      await api.putContent(id, html);
    } catch (err) {
      if (!(err instanceof MailchimpError) || err.kind !== 'unknown') throw err;
    }
    const wrong = verifyEmail(await api.getContent(id), expected);
    if (!wrong.length) return;
  }
  throw new MailchimpError('unknown', 'The new prices or date line did not stick in Mailchimp.');
}

/** Schedules and reads back. True only when Mailchimp holds it scheduled at that time. */
export async function scheduleChecked(api: MailchimpApi, id: string, at: number): Promise<boolean> {
  try {
    await api.schedule(id, mailchimpTime(at));
  } catch (err) {
    if (err instanceof MailchimpError && err.kind === 'setup') return false;
    // Refused or lost: the read below says what Mailchimp holds.
  }
  try {
    const c = await api.getCampaign(id);
    return c.status === 'schedule' && c.sendTime === at;
  } catch {
    return false;
  }
}
