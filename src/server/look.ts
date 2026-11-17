// The look of one running app: its branding and the versions of its static files. Pages read it
// from the request they are rendered for, so two apps in one process (as in tests) never mix.
// buildApp starts every request inside runWithLook. A page rendered outside a request, for
// example in a unit test, gets the neutral defaults, or the `look` passed to layout() directly.

import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultBranding, type Branding } from './branding.ts';

export interface Look {
  branding: Branding;
  /** Content hashes for the page's links, like 1a2b3c4d5e. Empty means no ?v= is added. */
  cssVersion: string;
  themeVersion: string;
  iconVersion: string;
  /** Content hashes of the optional scripts, by name, like { upload: '1a2b3c4d5e' }. */
  scriptVersions: Record<string, string>;
}

const store = new AsyncLocalStorage<Look>();

export function neutralLook(): Look {
  return { branding: defaultBranding(), cssVersion: '', themeVersion: '', iconVersion: '', scriptVersions: {} };
}

/** Runs next() so that every page rendered while it runs, awaited work included, uses this look. */
export function runWithLook<T>(look: Look, next: () => T): T {
  return store.run(look, next);
}

export function currentLook(): Look {
  return store.getStore() ?? neutralLook();
}
