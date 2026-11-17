// Fish days and check times, in the store's time zone. Pure: every function takes the time.
//
// Mailchimp takes and gives times in UTC. 8:00am in Chicago is 13:00Z in summer time and 14:00Z
// in winter time, so every local time is turned into UTC for its own date, never by a fixed offset.

import { WEEKDAYS, type MailchimpConfig, type Weekday } from './config.ts';

export interface LocalParts {
  /** YYYY-MM-DD in the store's time zone. */
  day: string;
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const date = Number(parts.day);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    year,
    month,
    date,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday as Weekday,
  };
}

/** The time zone's offset from UTC at that moment, in milliseconds (Chicago: -5 or -6 hours). */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.date, p.hour, p.minute, new Date(ms).getUTCSeconds());
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC moment of a local wall time on a local date ("2026-11-16", "08:00"). */
export function localToUtc(day: string, time: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset, including on the day the clocks change.
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

/** The local date n days after day. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(day: string): Weekday {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

export interface FishSend {
  /** The send day, YYYY-MM-DD, local. */
  day: string;
  /** When it goes, in UTC milliseconds. */
  at: number;
}

/**
 * The next fish day whose send time is at least the safe margin away. An email due sooner is left
 * to go as it is; the next one is the one to work on.
 */
export function nextFishSend(now: number, cfg: Pick<MailchimpConfig, 'timeZone' | 'fishDays' | 'sendTime' | 'safeMarginMinutes'>): FishSend {
  const today = localParts(now, cfg.timeZone).day;
  for (let i = 0; i < 15; i++) {
    const day = addDays(today, i);
    if (!cfg.fishDays.includes(weekdayOf(day))) continue;
    const at = localToUtc(day, cfg.sendTime, cfg.timeZone);
    if (at - now >= cfg.safeMarginMinutes * 60_000) return { day, at };
  }
  throw new Error('No fish day in the next two weeks. Check fishDays in the Mailchimp config.');
}

/** "Fish Email 20261116". */
export function fishTitle(prefix: string, day: string): string {
  return `${prefix} ${day.replace(/-/g, '')}`;
}

/** "Monday, November 16, 2026". */
export function dateLineText(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Mailchimp's schedule_time: UTC, whole seconds, "2026-11-16T14:00:00+00:00". */
export function mailchimpTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** A time Mailchimp gave, in milliseconds, or null. */
export function parseMailchimpTime(s: unknown): number | null {
  if (typeof s !== 'string' || s === '') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Mailchimp schedules only on quarter hours. */
export function onQuarterHour(ms: number): boolean {
  return ms % (15 * 60_000) === 0;
}

export interface CheckSlot {
  /** "YYYY-MM-DDTHH:MM", local. */
  slot: string;
  /** This check schedules a tracked email staff left unscheduled. */
  scheduleDrafts: boolean;
  /** When the check is due. */
  at: number;
  /** The fish send it guards: the next fish day at least the safe margin after the check. */
  guard: FishSend;
}

/** Every check slot from (not included) to (included), oldest first. */
export function checkSlotsBetween(from: number, to: number, cfg: MailchimpConfig): CheckSlot[] {
  const out: CheckSlot[] = [];
  const first = localParts(from, cfg.timeZone).day;
  const last = localParts(to, cfg.timeZone).day;
  for (let day = addDays(first, -1); day <= last; day = addDays(day, 1)) {
    const wd = weekdayOf(day);
    for (const c of cfg.checks) {
      if (!c.days.includes(wd)) continue;
      const at = localToUtc(day, c.time, cfg.timeZone);
      if (at > from && at <= to) out.push({ slot: `${day}T${c.time}`, scheduleDrafts: c.scheduleDrafts, at, guard: nextFishSend(at, cfg) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The check slot that is due at now, or null. A slot stays due until the fish send it guards is
 * within the safe margin, so a check missed while ShelfReady was off still runs when it starts
 * again. Later than that, it is a missed check (see missedCheckSlots).
 */
export function dueCheckSlot(now: number, cfg: MailchimpConfig): CheckSlot | null {
  const recent = checkSlotsBetween(now - 3 * 86400_000, now, cfg);
  const best = recent.at(-1);
  if (!best) return null;
  if (best.guard.at - now < cfg.safeMarginMinutes * 60_000) return null;
  return best;
}

/** Slots between two times that can no longer run: the send each guards is now too close or gone. */
export function missedCheckSlots(from: number, now: number, cfg: MailchimpConfig): CheckSlot[] {
  return checkSlotsBetween(from, now, cfg).filter((s) => s.guard.at - now < cfg.safeMarginMinutes * 60_000);
}

/** How long after its time a sent check still runs, so one missed while off runs late. */
export const SENT_CHECK_WINDOW_MS = 10 * 3600_000;

/**
 * The sent check due at now, or null: on a fish day, from the sent check time (8:15am) for ten
 * hours, it confirms that day's email went out. The slot is "YYYY-MM-DDTHH:MM", local.
 */
export function dueSentCheck(now: number, cfg: Pick<MailchimpConfig, 'timeZone' | 'fishDays' | 'sendTime' | 'sentCheckTime'>): { slot: string; day: string; sendAt: number } | null {
  const today = localParts(now, cfg.timeZone).day;
  for (const day of [today, addDays(today, -1)]) {
    if (!cfg.fishDays.includes(weekdayOf(day))) continue;
    const at = localToUtc(day, cfg.sentCheckTime, cfg.timeZone);
    if (now >= at && now - at < SENT_CHECK_WINDOW_MS) return { slot: `${day}T${cfg.sentCheckTime}`, day, sendAt: localToUtc(day, cfg.sendTime, cfg.timeZone) };
  }
  return null;
}

/**
 * The cutoff check due at now, or null: on a fish day, from the cutoff (7:00am) until the send
 * time, it reads Mailchimp for a second email scheduled to the fish list that morning.
 */
export function dueCutoffCheck(now: number, cfg: Pick<MailchimpConfig, 'timeZone' | 'fishDays' | 'sendTime' | 'safeMarginMinutes'>): { slot: string; day: string; sendAt: number } | null {
  const day = localParts(now, cfg.timeZone).day;
  if (!cfg.fishDays.includes(weekdayOf(day))) return null;
  const sendAt = localToUtc(day, cfg.sendTime, cfg.timeZone);
  const at = sendAt - cfg.safeMarginMinutes * 60_000;
  if (now < at || now >= sendAt) return null;
  const p = localParts(at, cfg.timeZone);
  return { slot: `${day}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`, day, sendAt };
}

/** True when a time falls in the morning (before noon, local) of a given local day. */
export function sameMorning(ms: number, day: string, tz: string): boolean {
  const p = localParts(ms, tz);
  return p.day === day && p.hour < 12;
}
