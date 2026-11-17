// The states of an invoice run and the moves allowed between them.
//
// uploaded      files saved, waiting for the job runner
// reading       the model is reading the invoice
// needs_approval  the reading would go over the cost cap: an admin must approve first
// retry         the invoice could not be read now (or ShelfReady restarted mid-reading); read again
// review        read, matched and priced, and something needs a person before a dry run
// ready         nothing blocks: a dry run may be made
// dry_run_done  the change preview exists and matches the current decisions
// approved      a person approved that exact preview
// sending       a person pressed Send: Square first, then the scales. The step within sending
//               is the send's phase (src/runs/send-store.ts): sending_square, square_done,
//               square_failed, scale_preview, sending_scales.
// partial       Square is done and some scale did not confirm a price: pending, with resend
// done          Square and every scale confirmed
// failed        stopped by a person (a send only while nothing reached Square), or the files
//               could not be used
//
// An approval that is too old goes back to ready for a new dry run, since Square has moved on.

export const RUN_STATES = ['uploaded', 'reading', 'needs_approval', 'retry', 'review', 'ready', 'dry_run_done', 'approved', 'sending', 'done', 'partial', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

const MOVES: Record<RunState, readonly RunState[]> = {
  uploaded: ['reading', 'retry', 'needs_approval', 'review', 'ready', 'failed'],
  reading: ['needs_approval', 'retry', 'review', 'ready', 'failed'],
  needs_approval: ['reading', 'retry', 'failed'],
  retry: ['reading', 'needs_approval', 'review', 'ready', 'failed'],
  review: ['review', 'ready', 'reading', 'retry', 'needs_approval', 'failed'],
  ready: ['review', 'ready', 'dry_run_done', 'failed'],
  dry_run_done: ['review', 'ready', 'dry_run_done', 'approved', 'failed'],
  approved: ['sending', 'ready', 'review'],
  sending: ['done', 'partial', 'failed'],
  done: [],
  partial: ['done'],
  failed: [],
};

export function canMove(from: RunState, to: RunState): boolean {
  return MOVES[from].includes(to);
}

/** States in which the manager can still change decisions. */
export const DECIDING: ReadonlySet<RunState> = new Set(['review', 'ready', 'dry_run_done']);

/** Plain words for pages. */
export const STATE_LABELS: Record<RunState, string> = {
  uploaded: 'Waiting to be read',
  reading: 'Reading',
  needs_approval: 'Waiting for an admin to approve the cost',
  retry: 'Could not be read. Try again',
  review: 'Needs review',
  ready: 'Ready for a dry run',
  dry_run_done: 'Dry run done. Ready to approve',
  approved: 'Approved',
  sending: 'Sending',
  done: 'Done',
  partial: 'Partly sent',
  failed: 'Stopped',
};

export function isRunState(v: string): v is RunState {
  return (RUN_STATES as readonly string[]).includes(v);
}
