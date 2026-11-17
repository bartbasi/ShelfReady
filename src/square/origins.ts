// The two Square environments, their pinned origins and the words pages use for them.
//
// This is the only file in src/ that names the live Square host. The pre-commit hook allows it
// here and in scripts/square/live-readonly.ts, and refuses it anywhere else, so no other code can
// build a live URL around the checks in client.ts and writer.ts.
//
// Live Square is used only when the server config sets allowSquareProduction AND the admin setting
// squareEnvironment is production (docs/GO-LIVE.md). A run is tied to the environment its catalog
// was read in, and nothing of it is ever sent to the other one.

export type SquareEnv = 'sandbox' | 'production';

export const SQUARE_SANDBOX_ORIGIN = 'https://connect.squareupsandbox.com';
export const SQUARE_PRODUCTION_ORIGIN = 'https://connect.squareup.com';

/** The catalog source a run records for each environment. */
export type SquareSourceKind = 'square_sandbox' | 'square_production';

export function squareOrigin(env: SquareEnv): string {
  return env === 'production' ? SQUARE_PRODUCTION_ORIGIN : SQUARE_SANDBOX_ORIGIN;
}

export function sourceForEnv(env: SquareEnv): SquareSourceKind {
  return env === 'production' ? 'square_production' : 'square_sandbox';
}

/** The environment a recorded catalog source belongs to, or null for a saved file or anything else. */
export function envForSource(source: string): SquareEnv | null {
  if (source === 'square_production') return 'production';
  if (source === 'square_sandbox') return 'sandbox';
  return null;
}

/** Words for pages. The live one must never be mistaken for the sandbox. */
export const SQUARE_LIVE_LABEL = 'Square (live)';
export const SQUARE_SANDBOX_LABEL = 'Square sandbox';
export const FILE_SOURCE_LABEL = 'Saved catalog file (development, read only)';

/** The label for a recorded catalog source. Unknown sources are shown as they are. */
export function catalogSourceLabel(source: string): string {
  if (source === 'square_production') return SQUARE_LIVE_LABEL;
  if (source === 'square_sandbox') return SQUARE_SANDBOX_LABEL;
  if (source === 'file') return FILE_SOURCE_LABEL;
  return source;
}

/**
 * The environment ShelfReady uses now: production only with both switches on. The setting is
 * already locked to sandbox while allowSquareProduction is false (src/settings/store.ts); this
 * checks again, so a mistake in one place cannot reach live.
 */
export function effectiveEnvironment(setting: unknown, allowSquareProduction: boolean): SquareEnv {
  return setting === 'production' && allowSquareProduction === true ? 'production' : 'sandbox';
}

/**
 * Why a run read in one environment must not be sent in the environment used now, or null.
 * Words safe to show.
 */
export function mixedEnvironmentProblem(runSource: string, now: SquareEnv): string | null {
  const runEnv = envForSource(runSource);
  if (runEnv === null) return `This invoice was matched against a ${catalogSourceLabel(runSource).toLowerCase()}, not Square, so it cannot be sent.`;
  if (runEnv === now) return null;
  return `This invoice was read in ${catalogSourceLabel(runSource)}, but ShelfReady now uses ${catalogSourceLabel(sourceForEnv(now))}. A run never mixes the two. To go on with it, switch Square back in Settings. If nothing of it was sent yet, you may upload the invoice again instead.`;
}
