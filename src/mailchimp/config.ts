// The store's fish email settings, from config/mailchimp/<store>.json (in git: no secrets, no
// item data). Every store-specific value for step 11 lives there: the title format, the fish days
// and send time, the checks, the units, and the date line's look.
//
// The Mailchimp ids are store data, so they stay out of git. The file in git holds a placeholder
// list id. The real one goes in config/local/mailchimp.json (git ignores config/local/):
//
//   { "list": { "id": "<the fish list id>" } }
//
// That file may also hold the campaign ids the one-off scripts in scripts/mailchimp/ need, under
// "campaigns" (see localCampaignId). Until the real list id is set, the app treats Mailchimp as
// not set up (src/mailchimp/service.ts).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAILCHIMP_CONFIG = fileURLToPath(new URL('../../config/mailchimp/cheese-and-crackers.json', import.meta.url));
/** This install's Mailchimp ids, out of git. */
export const LOCAL_MAILCHIMP_CONFIG = fileURLToPath(new URL('../../config/local/mailchimp.json', import.meta.url));
/** The list id the file in git holds. It names no real list. */
export const PLACEHOLDER_LIST_ID = '0000000000';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** How an email unit compares with Square: per_pound needs a per-pound price, each a price per item. */
export type UnitKind = 'per_pound' | 'each';

export interface MailchimpConfig {
  list: { id: string; name: string };
  /** A fish email's title starts with this. ShelfReady names each one "<prefix> YYYYMMDD". */
  titlePrefix: string;
  timeZone: string;
  fishDays: Weekday[];
  /** HH:MM, local time, on a quarter hour (Mailchimp schedules only on quarter hours). */
  sendTime: string;
  /**
   * A fish day whose send time is closer than this is no longer the next fish day: ShelfReady
   * leaves an email that is about to go alone and works on the one after.
   */
  safeMarginMinutes: number;
  /**
   * When the checks with no invoice run. scheduleDrafts: at this check, a tracked email staff left
   * unscheduled gets the held changes and is scheduled (Bart: 6:00am on fish days).
   */
  checks: Array<{ days: Weekday[]; time: string; scheduleDrafts: boolean }>;
  /** On a fish day, when to confirm the email went out (HH:MM, after the send time). */
  sentCheckTime: string;
  /** The most price drift fixes one edit makes on its own. More are listed for a person. */
  driftMaxPerEdit: number;
  /** Where a new fish goes by default (step 11b). */
  newFishSection: string;
  /** The confirmed matches of email rows to Square items (store data, out of git). */
  matchesFile: string;
  /** Email units ShelfReady may change, and how each compares with Square. Any other unit is never changed. */
  units: Record<string, UnitKind>;
  dateLine: {
    /** The class that marks the date line, so a later edit updates it instead of adding another. */
    class: string;
    /** The date line goes first inside the first table with this class. */
    topTableClass: string;
    /** The inline style of the date line's cell. */
    style: string;
  };
}

const TIME = /^([01][0-9]|2[0-3]):(00|15|30|45)$/;
const CLASS = /^[A-Za-z][A-Za-z0-9_-]{1,40}$/;
const MAILCHIMP_ID = /^[a-z0-9]{6,20}$/;

function fail(path: string, what: string): never {
  throw new Error(`${path}: ${what}`);
}

function days(path: string, v: unknown, what: string): Weekday[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 7 || !v.every((d) => (WEEKDAYS as readonly string[]).includes(d as string))) fail(path, `${what} must list days like "Mon".`);
  return [...new Set(v as Weekday[])];
}

/** Checks a parsed config. Throws with a plain message naming the field. */
export function checkMailchimpConfig(raw: unknown, path = 'mailchimp config'): MailchimpConfig {
  const c = raw as Record<string, any>;
  if (!c || typeof c !== 'object') fail(path, 'not a JSON object.');
  if (!c.list || typeof c.list.id !== 'string' || !MAILCHIMP_ID.test(c.list.id)) fail(path, 'list.id must be a Mailchimp list id.');
  if (typeof c.list.name !== 'string' || c.list.name.length > 200) fail(path, 'list.name must be text.');
  if (typeof c.titlePrefix !== 'string' || !/^[A-Za-z0-9 &'-]{3,40}$/.test(c.titlePrefix)) fail(path, 'titlePrefix must be short plain text.');
  if (typeof c.timeZone !== 'string') fail(path, 'timeZone must be text.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: c.timeZone });
  } catch {
    fail(path, 'timeZone is not a known time zone.');
  }
  const fishDays = days(path, c.fishDays, 'fishDays');
  if (typeof c.sendTime !== 'string' || !TIME.test(c.sendTime)) fail(path, 'sendTime must be HH:MM on a quarter hour.');
  const margin = c.safeMarginMinutes;
  if (!Number.isInteger(margin) || margin < 15 || margin > 600) fail(path, 'safeMarginMinutes must be a whole number from 15 to 600.');
  if (!Array.isArray(c.checks) || c.checks.length > 10) fail(path, 'checks must be a list.');
  const checks = (c.checks as Array<Record<string, unknown>>).map((k, i) => {
    if (typeof k.time !== 'string' || !TIME.test(k.time)) fail(path, `checks[${i}].time must be HH:MM on a quarter hour.`);
    if (k.scheduleDrafts !== undefined && typeof k.scheduleDrafts !== 'boolean') fail(path, `checks[${i}].scheduleDrafts must be true or false.`);
    return { days: days(path, k.days, `checks[${i}].days`), time: k.time, scheduleDrafts: k.scheduleDrafts === true };
  });
  if (typeof c.sentCheckTime !== 'string' || !TIME.test(c.sentCheckTime) || c.sentCheckTime <= c.sendTime) fail(path, 'sentCheckTime must be HH:MM on a quarter hour, after sendTime.');
  // Each check on a fish day has its own slot, named by its time: no two may share a time.
  const cut = cutoffTime(c.sendTime, margin);
  for (const k of checks) {
    if (k.time === c.sentCheckTime) fail(path, 'sentCheckTime must not be the same time as a check.');
    if (k.time === cut) fail(path, `no check may be at ${cut}, the cutoff, which has its own check.`);
  }
  if (cut === c.sentCheckTime) fail(path, 'sentCheckTime must not be the cutoff time.');
  const maxDrift = c.driftMaxPerEdit ?? 10;
  if (!Number.isInteger(maxDrift) || maxDrift < 0 || maxDrift > 100) fail(path, 'driftMaxPerEdit must be a whole number from 0 to 100.');
  if (typeof c.newFishSection !== 'string' || c.newFishSection.length > 100) fail(path, 'newFishSection must be text.');
  if (typeof c.matchesFile !== 'string' || !c.matchesFile.endsWith('.json') || c.matchesFile.length > 300) fail(path, 'matchesFile must be the path of a .json file.');
  const units: Record<string, UnitKind> = {};
  if (!c.units || typeof c.units !== 'object') fail(path, 'units must map email units to per_pound or each.');
  for (const [u, k] of Object.entries(c.units as Record<string, unknown>)) {
    if (!/^[a-z]{1,10}$/.test(u) || (k !== 'per_pound' && k !== 'each')) fail(path, `units.${u} must be per_pound or each.`);
    units[u] = k;
  }
  const d = c.dateLine as Record<string, unknown> | undefined;
  if (!d || typeof d.class !== 'string' || !CLASS.test(d.class)) fail(path, 'dateLine.class must be a class name.');
  if (typeof d.topTableClass !== 'string' || !CLASS.test(d.topTableClass)) fail(path, 'dateLine.topTableClass must be a class name.');
  // The style goes inside a double-quoted attribute, so it may not close it or open a tag.
  if (typeof d.style !== 'string' || d.style.length > 600 || /["<>&]/.test(d.style)) fail(path, 'dateLine.style must be inline CSS with no quotes or angle brackets.');
  return {
    list: { id: c.list.id, name: c.list.name },
    titlePrefix: c.titlePrefix,
    timeZone: c.timeZone,
    fishDays,
    sendTime: c.sendTime,
    safeMarginMinutes: margin,
    checks,
    sentCheckTime: c.sentCheckTime,
    driftMaxPerEdit: maxDrift,
    newFishSection: c.newFishSection,
    matchesFile: c.matchesFile,
    units,
    dateLine: { class: d.class, topTableClass: d.topTableClass as string, style: d.style },
  };
}

/** The cutoff on a fish day: the send time less the safe margin, as HH:MM ("07:00"). */
export function cutoffTime(sendTime: string, marginMinutes: number): string {
  const [h, m] = sendTime.split(':').map(Number) as [number, number];
  const t = (((h * 60 + m - marginMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * This install's own Mailchimp ids (config/local/mailchimp.json), or an empty object when the file
 * is not there. Throws with a plain message when it is there but not right.
 */
export function readLocalMailchimp(path: string = LOCAL_MAILCHIMP_CONFIG): { list?: { id: string; name?: string }; campaigns?: Record<string, string> } {
  if (!existsSync(path)) return {};
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Cannot read the local Mailchimp config at ${path}.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'not a JSON object.');
  const out: { list?: { id: string; name?: string }; campaigns?: Record<string, string> } = {};
  if (raw.list !== undefined) {
    if (!raw.list || typeof raw.list.id !== 'string' || !MAILCHIMP_ID.test(raw.list.id)) fail(path, 'list.id must be a Mailchimp list id.');
    if (raw.list.name !== undefined && (typeof raw.list.name !== 'string' || raw.list.name.length > 200)) fail(path, 'list.name must be text.');
    out.list = { id: raw.list.id, ...(raw.list.name !== undefined ? { name: raw.list.name as string } : {}) };
  }
  if (raw.campaigns !== undefined) {
    if (!raw.campaigns || typeof raw.campaigns !== 'object' || Array.isArray(raw.campaigns)) fail(path, 'campaigns must map names to Mailchimp campaign ids.');
    const campaigns: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.campaigns as Record<string, unknown>)) {
      if (typeof v !== 'string' || !MAILCHIMP_ID.test(v)) fail(path, `campaigns.${k} must be a Mailchimp campaign id.`);
      campaigns[k] = v;
    }
    out.campaigns = campaigns;
  }
  return out;
}

/** A campaign id from config/local/mailchimp.json "campaigns", by name, or null when it is not there. */
export function localCampaignId(name: string, path: string = LOCAL_MAILCHIMP_CONFIG): string | null {
  return readLocalMailchimp(path).campaigns?.[name] ?? null;
}

/**
 * Reads the fish email config. For the store's own file (the default), the list in
 * config/local/mailchimp.json, when there is one, takes the place of the placeholder in git.
 */
export function loadMailchimpConfig(path: string = DEFAULT_MAILCHIMP_CONFIG, localPath: string | null = path === DEFAULT_MAILCHIMP_CONFIG ? LOCAL_MAILCHIMP_CONFIG : null): MailchimpConfig {
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Cannot read the Mailchimp config at ${path}.`);
  }
  const local = localPath ? readLocalMailchimp(localPath) : {};
  if (local.list && raw && typeof raw === 'object') raw = { ...raw, list: { ...(raw.list ?? {}), ...local.list } };
  return checkMailchimpConfig(raw, path);
}

/**
 * For the app: the store's config with this install's list, and null; or, when
 * config/local/mailchimp.json is there but not right, the config with the placeholder list and
 * why, so the app still starts with Mailchimp not set up. The reason names the file and the field,
 * never a value from it. A file in git that is not right still throws: that is a code problem.
 */
export function loadMailchimpConfigForApp(localPath: string = LOCAL_MAILCHIMP_CONFIG): { cfg: MailchimpConfig; problem: string | null } {
  try {
    return { cfg: loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, localPath), problem: null };
  } catch (err) {
    const cfg = loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, null);
    const why = err instanceof Error ? err.message : `Cannot read the local Mailchimp config at ${localPath}.`;
    return { cfg, problem: `The local Mailchimp config is not right, so Mailchimp is not set up. ${why} Fix it and restart ShelfReady.` };
  }
}

/** True while the list id is still the placeholder from git: Mailchimp is not set up. */
export function listIdMissing(cfg: MailchimpConfig): boolean {
  return cfg.list.id === PLACEHOLDER_LIST_ID;
}
