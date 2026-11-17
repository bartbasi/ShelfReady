// What an invoice run would change in the fish email, worked out from the run's dry run and the
// confirmed matches (src/mailchimp/matches.ts). The plan is pure; the preview reads Mailchimp,
// never writes.
//
// A row's price changes only when:
// - Bart confirmed its match to a Square item;
// - that item's price changes in this run, on exactly one variation (or the one the match pins);
// - no other email row is matched to the same item (several rows on one item, such as oysters by
//   variety, could never all take one price);
// - the email row has the expected shape, and its unit agrees with Square: a price per pound for
//   a row sold by the pound, a price per item for a row sold by the unit or the can. A row sold by
//   the dozen, by the package, or with "Call" is never changed.
// Everything else is left as it is and listed in review with the reason.

import type { ChangePreview } from '../runs/preview.ts';
import { MailchimpError, type Campaign, type MailchimpApi } from './client.ts';
import type { MailchimpConfig } from './config.ts';
import { dateLineText, fishTitle } from './days.ts';
import { centsText, editEmail, foldKey, parseRows, type RowChange } from './html.ts';
import { findDrift, type RegisterBook } from './register.ts';
import { MatchesError, type FishMatches } from './matches.ts';
import { campaignLabel, selectTarget } from './target.ts';

/**
 * One price to put in the email. Today every planned row comes from an invoice run, after Square
 * confirmed its price. A one-time correction of email prices that disagree with Square (a pending
 * decision for Bart) would add a second source here, such as "sync", planned from the catalog
 * instead of a run and approved on its own before any task is queued. editEmail and the worker
 * take rows the same way, whatever their source.
 */
export interface PlannedRow {
  /** The email row key. */
  key: string;
  itemId: string;
  variationId: string;
  label: string;
  toCents: number;
  perPound: boolean;
}

export interface NotChanged {
  key: string;
  why: string;
}

export function planRows(preview: Pick<ChangePreview, 'square'>, matches: FishMatches): { rows: PlannedRow[]; notChanged: NotChanged[] } {
  const confirmed = matches.rows.filter((m) => m.status === 'confirmed' && m.itemId);
  const perItem = new Map<string, number>();
  for (const m of confirmed) perItem.set(m.itemId!, (perItem.get(m.itemId!) ?? 0) + 1);
  const rows: PlannedRow[] = [];
  const notChanged: NotChanged[] = [];
  for (const m of confirmed) {
    const changes = preview.square.filter((c) => c.itemId === m.itemId && c.price !== null && (m.variationId === null || c.variationId === m.variationId));
    if (!changes.length) continue;
    if ((perItem.get(m.itemId!) ?? 0) > 1) {
      notChanged.push({ key: m.row, why: 'more than one email row is matched to this Square item, so ShelfReady cannot tell which price is which.' });
      continue;
    }
    if (changes.length > 1) {
      notChanged.push({ key: m.row, why: 'more than one Square variation of this item changes price. Name the variation in the fish matches file.' });
      continue;
    }
    const c = changes[0]!;
    rows.push({ key: m.row, itemId: c.itemId, variationId: c.variationId, label: c.label, toCents: c.price!.toCents, perPound: c.price!.perPound });
  }
  return { rows, notChanged };
}

/** Splits planned rows into edits and refusals by the email row's unit. */
export function unitCheck(html: string, rows: readonly PlannedRow[], cfg: Pick<MailchimpConfig, 'units'>): { edits: PlannedRow[]; notChanged: NotChanged[] } {
  const emailRows = parseRows(html);
  const edits: PlannedRow[] = [];
  const notChanged: NotChanged[] = [];
  for (const p of rows) {
    const found = emailRows.filter((r) => foldKey(r.key) === foldKey(p.key));
    const unit = found.length === 1 ? found[0]!.unit : '';
    const kind = found.length === 1 && Object.hasOwn(cfg.units, unit) ? cfg.units[unit] : undefined;
    if (found.length === 1 && kind && (kind === 'per_pound') !== p.perPound) {
      notChanged.push({ key: p.key, why: `the email sells it by the ${found[0]!.unit}, but Square ${p.perPound ? 'prices it per pound' : 'prices it per item'}. Check the match.` });
      continue;
    }
    // Missing rows and other shapes are refused, with the reason, by editEmail.
    edits.push(p);
  }
  return { edits, notChanged };
}

export interface MailchimpPreview {
  madeAt: number;
  /** Why the email cannot be worked out or changed, or ''. */
  problem: string;
  /** Something a person must know before sending, such as a test setting that reaches the live email. */
  warning?: string;
  planned: PlannedRow[];
  target: { kind: 'edit' | 'copy' | 'stop'; campaignId: string; campaignTitle: string; day: string; dayText: string; reason: string } | null;
  titleFix: { from: string; to: string } | null;
  dateLine: { from: string | null; to: string } | null;
  dateLineProblem: string;
  changes: RowChange[];
  same: string[];
  notChanged: NotChanged[];
  /** Email rows with no confirmed match: never changed. */
  unmatched: string[];
  /** Rows whose price differs from the register: set to the register price on send. */
  drift?: Array<{ key: string; from: string; to: string }>;
  /** Staff have the tracked email unscheduled: the change is held. */
  heldNote?: string;
}

/** The fish emails on the list that matter now: scheduled, sending and the recent sent ones. */
export async function fishCampaigns(api: MailchimpApi, cfg: MailchimpConfig): Promise<Campaign[]> {
  const listId = cfg.list.id;
  const [scheduled, sending, sent] = [
    await api.listCampaigns({ listId, status: 'schedule', sortField: 'create_time', count: 100 }),
    await api.listCampaigns({ listId, status: 'sending', sortField: 'create_time', count: 20 }),
    await api.listCampaigns({ listId, status: 'sent', sortField: 'send_time', count: 20 }),
  ];
  return [...scheduled, ...sending, ...sent];
}

export function dayText(day: string): string {
  return dateLineText(day);
}

export interface PreviewDeps {
  cfg: MailchimpConfig;
  /** Null with the reason when Mailchimp cannot be used (no key, a risky environment). */
  api: MailchimpApi | null;
  setupProblem: string;
  matches: () => FishMatches;
  now: number;
  /** The most the Mailchimp reads may take together. Past it, the preview says Mailchimp did not answer. */
  timeoutMs?: number;
  /** The campaign ShelfReady tracks for a fish day, if any. */
  tracked?: (day: string) => string | null;
  /** How many invoice changes are held for a fish day. */
  held?: (day: string) => number;
  /** The register prices, when this install may use them for the drift check. */
  register?: () => Promise<RegisterBook | null>;
  /** The big-change limit in percent, for drift fixes. */
  driftPercent?: () => number;
  /** ShelfReady's own email for the last fish day, the copy source, as the worker finds it. */
  source?: (api: MailchimpApi) => Promise<Campaign | null>;
}

/** The dry run waits at most this long for Mailchimp, so a slow Mailchimp never holds up a dry run. */
export const PREVIEW_TIMEOUT_MS = 15_000;

/** What the run would change in the fish email, as Mailchimp holds it now. Reads only. */
export async function buildMailchimpPreview(deps: PreviewDeps, preview: Pick<ChangePreview, 'square'>): Promise<MailchimpPreview | null> {
  const out: MailchimpPreview = { madeAt: deps.now, problem: '', planned: [], target: null, titleFix: null, dateLine: null, dateLineProblem: '', changes: [], same: [], notChanged: [], unmatched: [] };
  let matches: FishMatches;
  try {
    matches = deps.matches();
  } catch (err) {
    out.problem = err instanceof MatchesError ? err.message : 'The fish matches file cannot be used.';
    return out;
  }
  const plan = planRows(preview, matches);
  out.planned = plan.rows;
  out.notChanged.push(...plan.notChanged);
  // No fish price changes in this run: nothing to show, and nothing to do on send.
  if (!plan.rows.length && !plan.notChanged.length) return null;
  if (!deps.api) {
    out.problem = `${deps.setupProblem} The fish email will not change.`;
    return out;
  }
  const api = deps.api;
  // The reads fill a copy; it is used only if they finish in time.
  const mc: MailchimpPreview = structuredClone(out);
  const fill = async (): Promise<void> => {
    try {
      await fillFromMailchimp(mc, api, deps, plan.rows, matches);
    } catch (err) {
      mc.problem = `ShelfReady could not read the fish email in Mailchimp. ${err instanceof MailchimpError ? err.message : 'Something went wrong.'} Nothing was changed.`;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => {
    // Not unref'd: it is always cleared below, and it must fire even when nothing else is pending.
    timer = setTimeout(() => r('late'), deps.timeoutMs ?? PREVIEW_TIMEOUT_MS);
  });
  const res = await Promise.race([fill().then(() => 'ok' as const), late]);
  clearTimeout(timer);
  if (res === 'late') {
    // The planned rows stay, so the send still puts the prices in when Square confirms them.
    out.problem = 'Mailchimp did not answer in time, so the fish email change cannot be shown here. Nothing was changed. On send, ShelfReady reads Mailchimp again.';
    return out;
  }
  return mc;
}

async function fillFromMailchimp(out: MailchimpPreview, api: MailchimpApi, deps: PreviewDeps, rows: PlannedRow[], matches: FishMatches): Promise<void> {
  const plan = { rows };
  {
    const target = selectTarget(await fishCampaigns(api, deps.cfg), deps.now, deps.cfg, { source: deps.source ? await deps.source(api) : null });
    const day = target.send.day;
    const title = fishTitle(deps.cfg.titlePrefix, day);
    const trackedId = deps.tracked?.(day) ?? null;
    if (trackedId) {
      // ShelfReady's own email for that day, whatever its state.
      const c = await api.getCampaign(trackedId);
      const draft = c.status === 'save' || c.status === 'paused';
      out.target = { kind: 'edit', campaignId: c.id, campaignTitle: c.title, day, dayText: dayText(day), reason: `Edit ShelfReady's email for ${dayText(day)}, ${campaignLabel(c)} (${c.status === 'schedule' ? 'scheduled' : c.status}).` };
      if (draft) {
        const n = deps.held?.(day) ?? 0;
        out.heldNote = `Staff have it unscheduled, so this change is held${n ? ` with ${n} other held ${n === 1 ? 'change' : 'changes'}` : ''} until they schedule it, or until 6:00am on ${dayText(day)}, when ShelfReady puts the changes in and schedules it.`;
      }
      if (c.title !== title) out.titleFix = { from: c.title, to: title };
      await previewEdits(out, api, deps, c.id, day, plan.rows, matches);
      return;
    }
    if (target.kind === 'stop') {
      out.target = { kind: 'stop', campaignId: '', campaignTitle: '', day, dayText: dayText(day), reason: target.reason };
      return;
    }
    const c = target.kind === 'edit' ? target.campaign : target.source;
    out.target = {
      kind: target.kind,
      campaignId: c.id,
      campaignTitle: c.title,
      day,
      dayText: dayText(day),
      reason: target.kind === 'edit' ? `Edit the scheduled fish email ${campaignLabel(c)}.` : `No fish email is scheduled for ${dayText(day)} yet. On send, ShelfReady copies the last one sent, ${campaignLabel(c)}, and schedules the copy.`,
    };
    // A copy's name is Mailchimp's own ("... (copy NN)"), so it is shown as "" (a new copy).
    if (target.kind === 'copy' || c.title !== title) out.titleFix = { from: target.kind === 'copy' ? '' : c.title, to: title };
    await previewEdits(out, api, deps, c.id, day, plan.rows, matches);
  }
}

/** The run's own price changes on the email as it is now, and the register drift beside them. */
async function previewEdits(out: MailchimpPreview, api: MailchimpApi, deps: PreviewDeps, campaignId: string, day: string, rows: PlannedRow[], matches: FishMatches): Promise<void> {
  const html = await api.getContent(campaignId);
  const units = unitCheck(html, rows, deps.cfg);
  out.notChanged.push(...units.notChanged);
  const edit = editEmail(html, units.edits.map((r) => ({ key: r.key, toCents: r.toCents })), { units: deps.cfg.units, dateLine: deps.cfg.dateLine, dateText: dateLineText(day) });
  out.changes = edit.changes;
  out.same = edit.same;
  out.notChanged.push(...edit.refused);
  out.dateLine = edit.dateLine ? { from: edit.dateLine.from, to: edit.dateLine.to } : null;
  out.dateLineProblem = edit.dateLineProblem;
  const confirmedKeys = new Set(matches.rows.filter((m) => m.status !== 'proposed').map((m) => foldKey(m.row)));
  out.unmatched = parseRows(html).filter((r) => !confirmedKeys.has(foldKey(r.key))).map((r) => r.key);
  const book = deps.register ? await deps.register() : null;
  if (book) {
    const mine = new Set(units.edits.map((r) => foldKey(r.key)));
    const drift = findDrift(html, matches, book, deps.cfg, { percent: deps.driftPercent?.() ?? 30, maxCount: deps.cfg.driftMaxPerEdit });
    out.drift = drift.fixes.filter((f) => !mine.has(foldKey(f.key))).map((f) => ({ key: f.key, from: f.fromText, to: centsText(f.toCents) }));
    out.notChanged.push(...drift.forPerson);
  }
}
