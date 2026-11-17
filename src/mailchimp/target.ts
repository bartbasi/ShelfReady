// Which campaign to work on, by Bart's rules (store/docs/DECISIONS.md, Fish prices in Mailchimp). Pure.
//
// - A fish email is a campaign on the fish list whose title starts with the prefix ("Fish Email").
//   Other campaigns are never touched.
// - Paused campaigns are ignored (Bart). Drafts are ignored here too: staff may be working on one,
//   and a draft goes nowhere. When this says copy, the worker (src/mailchimp/worker.ts) first
//   takes up a copy or unscheduled email ShelfReady itself left unfinished for that day, known by
//   id from its own records, never by its look; and it makes no copy while another task's red
//   alert for that day is open.
// - Sending, and scheduled ones due within the safe margin, are going out now: left alone.
// - The next fish day is the next Mon, Wed or Fri at the send time that is still at least the safe
//   margin away (src/mailchimp/days.ts).
// - Exactly one scheduled fish email, for that day: edit it.
// - None: copy ShelfReady's own email for the last fish day, when it went to the whole list.
//   Without one, copy the latest fish email sent to the whole list, only when it was the only one
//   sent that day; two the same day is a stop. An email sent to a segment is never copied.
// - More than one, or one for another day: stop, change nothing, and say so plainly.

import type { Campaign } from './client.ts';
import type { MailchimpConfig } from './config.ts';
import { localParts, nextFishSend, type FishSend } from './days.ts';

export type Target =
  | { kind: 'edit'; campaign: Campaign; send: FishSend }
  | { kind: 'copy'; source: Campaign; send: FishSend }
  | { kind: 'stop'; reason: string; send: FishSend };

export function isFishEmail(c: Campaign, cfg: Pick<MailchimpConfig, 'list' | 'titlePrefix'>): boolean {
  return c.listId === cfg.list.id && c.title.startsWith(cfg.titlePrefix);
}

function when(c: Campaign, tz: string): string {
  if (c.sendTime === null) return 'no time';
  const p = localParts(c.sendTime, tz);
  return `${p.weekday} ${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** A plain name for a campaign on pages: its title and id. Titles come from Mailchimp: data, escaped on pages. */
export function campaignLabel(c: Pick<Campaign, 'title' | 'id'>): string {
  return `"${c.title}" (${c.id})`;
}

/**
 * opts.source: ShelfReady's own email for the last fish day, when it went out to the whole list.
 * That is the copy source. Without it, the latest fish email sent to the whole list is used, but
 * only when it was the only one sent that day: ShelfReady never picks between two.
 */
export function selectTarget(campaigns: readonly Campaign[], now: number, cfg: MailchimpConfig, opts: { source?: Campaign | null } = {}): Target {
  const send = nextFishSend(now, cfg);
  const margin = cfg.safeMarginMinutes * 60_000;
  const fish = campaigns.filter((c) => isFishEmail(c, cfg));
  const unique = [...new Map(fish.map((c) => [c.id, c])).values()];
  const scheduled = unique.filter((c) => c.status === 'schedule' && c.sendTime !== null && c.sendTime - now >= margin);
  const tz = cfg.timeZone;
  if (scheduled.length > 1) {
    return {
      kind: 'stop',
      send,
      reason: `More than one fish email is scheduled: ${scheduled.map((c) => `${campaignLabel(c)} for ${when(c, tz)}`).join(', ')}. ShelfReady changed nothing. Unschedule the extra one in Mailchimp, and ShelfReady will carry on.`,
    };
  }
  if (scheduled.length === 1) {
    const c = scheduled[0]!;
    const day = localParts(c.sendTime!, tz).day;
    if (day !== send.day) {
      return {
        kind: 'stop',
        send,
        reason: `The scheduled fish email ${campaignLabel(c)} is for ${when(c, tz)}, but the next fish day is ${send.day}. ShelfReady changed nothing. Fix the schedule in Mailchimp, and ShelfReady will carry on.`,
      };
    }
    return { kind: 'edit', campaign: c, send };
  }
  if (opts.source && opts.source.status === 'sent' && !opts.source.segmented) return { kind: 'copy', source: opts.source, send };
  // Only an email sent to the whole list can be copied: one sent to a segment never is.
  const sent = unique.filter((c) => c.status === 'sent' && c.sendTime !== null && !c.segmented).sort((a, b) => b.sendTime! - a.sendTime!);
  if (!sent.length) return { kind: 'stop', send, reason: 'No fish email sent to the whole list was found to copy. ShelfReady changed nothing.' };
  const lastDay = localParts(sent[0]!.sendTime!, tz).day;
  const sameDay = sent.filter((c) => localParts(c.sendTime!, tz).day === lastDay);
  if (sameDay.length > 1) {
    return {
      kind: 'stop',
      send,
      reason: `More than one fish email went out on ${lastDay}: ${sameDay.map((c) => campaignLabel(c)).join(', ')}. ShelfReady will not choose which to copy, and changed nothing. Make sure one fish email is scheduled for ${send.day}, then clear this alert.`,
    };
  }
  return { kind: 'copy', source: sent[0]!, send };
}
