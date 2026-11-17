// The background jobs that send a run, for the job runner (src/runs/runner.ts).
//
// After a restart:
// - send_square goes again: every write it already stored is sent with the same idempotency key
//   and body, so nothing is applied twice, and every other write is checked against Square first.
// - send_scales, resend_apply and scale_lookup go again: a scale apply stored as applying is only
//   looked up by its preview id, never applied again.
// - scale_preview and resend_compare read scales. A read can freeze a real scale, so they are not
//   run again on their own: the person presses again.
// - corrections go again, with the same keys.

import { prepareScalePreview, applyScales, lookupResults, resendCompare, resendApply } from './scale-push.ts';
import { runCorrectionsJob, runSquareSend, type SendDeps } from './square-send.ts';
import type { Job, SendJobKind } from './store.ts';

export interface SendJobs {
  run(job: Job): Promise<void>;
  /** True when a job of this kind may simply run again after a restart. */
  safeToRepeat(kind: SendJobKind): boolean;
}

const REPEATABLE: ReadonlySet<SendJobKind> = new Set(['send_square', 'send_scales', 'scale_lookup', 'resend_apply', 'corrections']);

export function createSendJobs(deps: SendDeps): SendJobs {
  return {
    async run(job) {
      switch (job.kind) {
        case 'send_square':
          return runSquareSend(deps, job.runId, prepareScalePreview);
        case 'scale_preview':
          return prepareScalePreview(deps, job.runId);
        case 'send_scales':
          return applyScales(deps, job.runId);
        case 'scale_lookup':
          return lookupResults(deps, job.runId);
        case 'resend_compare':
          return resendCompare(deps, job.runId);
        case 'resend_apply':
          return resendApply(deps, job.runId);
        case 'corrections':
          return runCorrectionsJob(deps, job.runId);
        default:
          throw new Error('not a send job');
      }
    },
    safeToRepeat: (kind) => REPEATABLE.has(kind),
  };
}
