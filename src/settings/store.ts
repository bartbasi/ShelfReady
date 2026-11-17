// The settings other code calls: getSetting for plain values, getSecret for keys and tokens.
// Every value is stored encrypted. Secrets never leave this module except through getSecret,
// and only secretStatus (set or not, and at most the last 4 characters) goes to a screen.
//
// A row that fails its integrity check makes getSetting and getSecret throw, so no code acts on
// a value it cannot trust. The settings page shows such a row as damaged, and a new value
// overwrites it without the old one ever being read.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { open, seal, type MasterKeys } from './crypto.ts';
import {
  checkSecret,
  checkSetting,
  defaultSettings,
  isSecretName,
  isSettingName,
  SETTING_NAMES,
  SettingError,
  withDefaults,
  type SecretName,
  type SettingName,
  type SettingValues,
} from './schema.ts';

interface Row {
  name: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

export interface SecretStatus {
  set: boolean;
  /** Last 4 characters, only for values long enough that 4 characters give little away. */
  hint: string;
  /** The stored value failed its integrity check. Enter it again. */
  damaged: boolean;
}

/** A batch of changes. A secret set to null is cleared. A secret left out is unchanged. */
export interface SettingsChange {
  values?: Partial<SettingValues>;
  secrets?: Partial<Record<SecretName, string | null>>;
}

export interface SettingsView {
  /** Values for the form. A damaged value shows its default. */
  values: SettingValues;
  damaged: SettingName[];
  /** Production is stored but the config does not allow it, so sandbox is used. */
  productionLocked: boolean;
}

export interface Settings {
  getSetting<K extends SettingName>(name: K): SettingValues[K];
  getSecret(name: SecretName): string | undefined;
  /**
   * The Square environment the saved Square access token belongs to, or null when no token is
   * saved. The Square clients send the token only to that environment. A token saved before this
   * was recorded counts as the sandbox's: live Square could not be chosen then. Throws if damaged.
   */
  squareTokenEnvironment(): 'sandbox' | 'production' | null;
  secretStatus(name: SecretName): SecretStatus;
  /** For the settings page. Never throws on a damaged row. */
  view(): SettingsView;
  /** Checks everything first, then writes in one transaction and logs names, never secret values. */
  update(change: SettingsChange, actor: AuditActor): { changed: string[] };
}

// Secrets and plain values share one table, so their names must not collide.
const secretRowName = (name: SecretName): string => `secret:${name}`;
const valueRowName = (name: SettingName): string => `value:${name}`;
/** Which Square environment the saved Square access token was entered for. Encrypted like the rest. */
const SQUARE_TOKEN_ENV_ROW = 'bind:squareAccessToken';

const DAMAGED = Symbol('damaged');

export function createSettings(db: Db, mk: MasterKeys, opts: { allowSquareProduction: boolean; now?: () => number }): Settings {
  const now = opts.now ?? Date.now;

  const read = (rowName: string): string | undefined => {
    const r = db.prepare('SELECT name, key_id, nonce, ciphertext, tag FROM settings WHERE name = ?').get(rowName) as Row | undefined;
    if (!r) return undefined;
    return open(mk, { keyId: r.key_id, nonce: Buffer.from(r.nonce), ciphertext: Buffer.from(r.ciphertext), tag: Buffer.from(r.tag) }, r.name);
  };

  /** Like read, but a damaged row comes back as DAMAGED instead of throwing. */
  const tryRead = (rowName: string): string | undefined | typeof DAMAGED => {
    try {
      return read(rowName);
    } catch {
      return DAMAGED;
    }
  };

  const write = (rowName: string, plaintext: string, userId: number | null, t: number): void => {
    const s = seal(mk, plaintext, rowName);
    db.prepare(
      `INSERT INTO settings (name, key_id, nonce, ciphertext, tag, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
         tag = excluded.tag, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(rowName, s.keyId, s.nonce, s.ciphertext, s.tag, new Date(t).toISOString(), userId);
  };

  /**
   * The daily limit must hold at least one reading at the cost cap per invoice, or every reading
   * would wait for an admin. 0 is allowed: it means always ask. Checked on the values after this
   * save, so either one may be changed alone. A damaged stored value is not checked against.
   */
  function checkLimitAgainstCap(values: ReadonlyArray<[SettingName, unknown]>): void {
    const next = new Map(values);
    const saved = (name: 'dailyLimitUsd' | 'invoiceCostCapUsd'): number | null => {
      try {
        return Number(stored(name));
      } catch {
        return null;
      }
    };
    const value = (name: 'dailyLimitUsd' | 'invoiceCostCapUsd'): number | null => (next.has(name) ? Number(next.get(name)) : saved(name));
    const limit = value('dailyLimitUsd');
    const cap = value('invoiceCostCapUsd');
    if (limit === null || cap === null || limit === 0 || limit >= cap) return;
    const usd = (n: number) => '$' + n.toFixed(2);
    const words = 'Every reading would wait for an admin. Use 0.00 for the daily limit if that is what you want.';
    // The settings form posts both every time, so speak about the one that changed.
    const capChanged = next.has('invoiceCostCapUsd') && cap !== saved('invoiceCostCapUsd');
    const limitChanged = next.has('dailyLimitUsd') && limit !== saved('dailyLimitUsd');
    if (limitChanged || !capChanged) throw new SettingError('dailyLimitUsd', `The daily limit, ${usd(limit)}, is less than the reading cost cap per invoice, ${usd(cap)}. ${words}`);
    throw new SettingError('invoiceCostCapUsd', `The reading cost cap per invoice, ${usd(cap)}, is more than the daily limit, ${usd(limit)}. ${words}`);
  }

  /** Stored value merged with defaults, before the production lock. Throws if damaged. */
  function stored<K extends SettingName>(name: K): SettingValues[K] {
    const text = read(valueRowName(name));
    if (text === undefined) return defaultSettings()[name];
    return withDefaults(name, JSON.parse(text));
  }

  /** The production lock applies every time the value is read, not only when it is saved. */
  function locked<K extends SettingName>(name: K, v: SettingValues[K]): SettingValues[K] {
    if (name === 'squareEnvironment' && v === 'production' && !opts.allowSquareProduction) return 'sandbox' as SettingValues[K];
    return v;
  }

  function getSetting<K extends SettingName>(name: K): SettingValues[K] {
    if (!isSettingName(name)) throw new Error(`Unknown setting ${String(name)}`);
    return locked(name, stored(name));
  }

  function getSecret(name: SecretName): string | undefined {
    if (!isSecretName(name)) throw new Error(`Unknown secret ${String(name)}`);
    return read(secretRowName(name));
  }

  function squareTokenEnvironment(): 'sandbox' | 'production' | null {
    if (read(secretRowName('squareAccessToken')) === undefined) return null;
    const bound = read(SQUARE_TOKEN_ENV_ROW);
    if (bound === undefined) return 'sandbox';
    const v = JSON.parse(bound) as unknown;
    if (v !== 'sandbox' && v !== 'production') throw new Error('The saved Square token environment is not one ShelfReady knows.');
    return v;
  }

  function secretStatus(name: SecretName): SecretStatus {
    const v = tryRead(secretRowName(name));
    if (v === DAMAGED) return { set: true, hint: '', damaged: true };
    if (v === undefined) return { set: false, hint: '', damaged: false };
    return { set: true, hint: v.length >= 20 ? v.slice(-4) : '', damaged: false };
  }

  function view(): SettingsView {
    const values = defaultSettings() as unknown as Record<SettingName, unknown>;
    const damaged: SettingName[] = [];
    let productionLocked = false;
    for (const k of SETTING_NAMES) {
      try {
        const v = stored(k);
        if (k === 'squareEnvironment' && v === 'production' && !opts.allowSquareProduction) productionLocked = true;
        values[k] = locked(k, v);
      } catch {
        damaged.push(k);
      }
    }
    return { values: values as unknown as SettingValues, damaged, productionLocked };
  }

  function update(change: SettingsChange, actor: AuditActor): { changed: string[] } {
    const t = now();
    // Check every field before writing any of them.
    const values: [SettingName, unknown][] = [];
    for (const [k, v] of Object.entries(change.values ?? {})) {
      if (!isSettingName(k)) throw new SettingError(k, 'Unknown setting.');
      values.push([k, checkSetting(k, v, opts)]);
    }
    checkLimitAgainstCap(values);
    const secrets = new Map<SecretName, string | null>();
    for (const [k, v] of Object.entries(change.secrets ?? {})) {
      if (!isSecretName(k)) throw new SettingError(k, 'Unknown setting.');
      if (v === undefined) continue;
      secrets.set(k, v === null ? null : checkSecret(k, v));
    }
    return inTransaction(db, () => {
      const changedValues: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, v] of values) {
        // A damaged row is overwritten without being read.
        let before: unknown;
        try {
          before = stored(k);
        } catch {
          before = '(damaged)';
        }
        if (JSON.stringify(before) === JSON.stringify(v)) continue;
        write(valueRowName(k), JSON.stringify(v), actor.userId, t);
        changedValues[k] = { from: before, to: v };
      }
      // A new ScaleConnect address must come with its token in the same save. Otherwise the old
      // token is removed, so a stolen session cannot point the token at another server.
      if (changedValues.scaleConnectUrl && !(typeof secrets.get('scaleConnectToken') === 'string')) {
        secrets.set('scaleConnectToken', null);
      }
      // The same for Square: a token belongs to one environment. A change of environment must come
      // with the token for the new one. Otherwise the old token is removed, so a live token is never
      // sent to the sandbox, nor a sandbox token taken for live.
      if (changedValues.squareEnvironment && !(typeof secrets.get('squareAccessToken') === 'string')) {
        secrets.set('squareAccessToken', null);
      }
      // The environment a new token is entered for: the one in use after this save.
      let tokenEnv: 'sandbox' | 'production' = 'sandbox';
      if (typeof secrets.get('squareAccessToken') === 'string') {
        try {
          tokenEnv = locked('squareEnvironment', stored('squareEnvironment')) === 'production' ? 'production' : 'sandbox';
        } catch {
          throw new SettingError('squareEnvironment', 'The saved Square environment is damaged. Choose it again in the same save as the token.');
        }
      }
      const changedSecrets: Record<string, 'set' | 'cleared'> = {};
      for (const [k, v] of secrets) {
        if (v === null) {
          const res = db.prepare('DELETE FROM settings WHERE name = ?').run(secretRowName(k));
          if (k === 'squareAccessToken') db.prepare('DELETE FROM settings WHERE name = ?').run(SQUARE_TOKEN_ENV_ROW);
          if (Number(res.changes) > 0) changedSecrets[k] = 'cleared';
        } else {
          if (k === 'squareAccessToken') {
            // Recorded on every save of the token, so the same token entered again for another
            // environment is bound to that one.
            const before = tryRead(SQUARE_TOKEN_ENV_ROW);
            if (before !== JSON.stringify(tokenEnv)) write(SQUARE_TOKEN_ENV_ROW, JSON.stringify(tokenEnv), actor.userId, t);
            if (tryRead(secretRowName(k)) === v && before === JSON.stringify(tokenEnv)) continue;
            if (tryRead(secretRowName(k)) === v) {
              changedSecrets[k] = 'set';
              continue;
            }
          } else if (tryRead(secretRowName(k)) === v) continue;
          write(secretRowName(k), v, actor.userId, t);
          changedSecrets[k] = 'set';
        }
      }
      const changed = [...Object.keys(changedValues), ...Object.keys(changedSecrets)];
      if (changed.length > 0) {
        // Plain values are logged before and after. Secrets only as "set" or "cleared".
        appendAudit(db, actor, { action: 'settings.update', entityType: 'settings', details: { values: changedValues, secrets: changedSecrets } }, t);
      }
      return { changed };
    });
  }

  return { getSetting, getSecret, squareTokenEnvironment, secretStatus, view, update };
}
