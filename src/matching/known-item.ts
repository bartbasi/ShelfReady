// Wires matching into the invoice checks through their knownItem hook.
//
// A line is known when it matched a Square item or is marked not for resale. An unknown line
// fails the blocking misread_codes check only when its printed code looks misread: reading the
// invoice again on the fallback model can fix a misread, but it cannot add an item to Square.
// Every other unknown line (a new item, or one no person has matched yet) goes to review with
// its candidates, and does not cost a second reading. See store/docs/DECISIONS.md, November 7.

import type { KnownItemAnswer, KnownItemLookup } from '../invoice/checks.ts';
import type { ModelInvoice } from '../invoice/types.ts';
import { createLineMatcher, resolveSupplier, type LineMatch, type LineMatcher, type MatchContext } from './matcher.ts';

/** The check's answer for one matched line. */
export function knownItemAnswer(m: LineMatch): KnownItemAnswer {
  switch (m.status) {
    case 'matched':
      return { known: true, note: `matched ${m.match.label}` };
    case 'not_for_resale':
      return { known: true, note: 'marked not for resale' };
    case 'candidates':
      return {
        known: false,
        possibleMisread: m.possibleMisread,
        note: m.possibleMisread ? misreadNote(m) : `pick from ${m.candidates.length} possible Square ${m.candidates.length === 1 ? 'item' : 'items'}`,
      };
    case 'new_item':
      return { known: false, possibleMisread: m.possibleMisread, note: m.possibleMisread ? misreadNote(m) : 'no Square item looks like it, so it may be new' };
  }
}

function misreadNote(m: LineMatch): string {
  const why = m.reasons.find((r) => /misread/.test(r));
  return (why ?? 'its code may be misread').replace(/\.$/, '');
}

/** The hook for checkReading and readInvoice. One matcher per invoice, so the supplier is looked up once. */
export function knownItemLookup(ctx: MatchContext): KnownItemLookup {
  const matchers = new WeakMap<ModelInvoice, LineMatcher>();
  return (cl, invoice) => {
    let match = matchers.get(invoice);
    if (!match) {
      const s = resolveSupplier(ctx.db, invoice.supplier_name);
      match = createLineMatcher(ctx, s.status === 'known' ? s.supplier : null);
      matchers.set(invoice, match);
    }
    return knownItemAnswer(match(cl.line, cl.n, cl.pack));
  };
}
