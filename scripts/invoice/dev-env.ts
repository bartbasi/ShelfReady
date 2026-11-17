// Development only: builds a Claude client with ANTHROPIC_API_KEY read by name from
// ~/.config/shelfready/dev.env. The key is never printed, logged or put in an error message.
// The app itself takes the key from encrypted settings, not from this file.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { createInvoiceAnthropicClient } from '../../src/invoice/extract.ts';

const DEV_ENV = join(homedir(), '.config/shelfready/dev.env');

function readEnvKey(key: string): string {
  const mode = statSync(DEV_ENV).mode & 0o777;
  if (mode & 0o077) throw new Error('~/.config/shelfready/dev.env must be mode 600. Run: chmod 600 ~/.config/shelfready/dev.env');
  const text = readFileSync(DEV_ENV, 'utf8');
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    // Only file formatting is removed: a carriage return at the end (a file saved on Windows),
    // spaces around the value and surrounding quotes. Anything odd inside the value is left for
    // the key shape check to refuse.
    if (i > 0 && line.slice(0, i).trim() === key) {
      const v = line.slice(i + 1).replace(/\r$/, '').replace(/^[ \t]+|[ \t]+$/g, '').replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  throw new Error(`${key} is not set in ~/.config/shelfready/dev.env`);
}

/** A client pinned to https://api.anthropic.com, with the key's shape checked first. */
export function devAnthropicClient(): Anthropic {
  return createInvoiceAnthropicClient(readEnvKey('ANTHROPIC_API_KEY'));
}
