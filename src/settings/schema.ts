// What the settings are, their defaults and how each is checked.
// Store-specific values belong here as data entered on the settings screen, never in code.

import { shelfCentsForText, vendorKey } from '../pricing/formula.ts';

export type SquareEnvironment = 'sandbox' | 'production';
export type Rounding = 'up-to-99';
export const ROUNDINGS: readonly Rounding[] = ['up-to-99'];

/**
 * shelf = (cost + addBefore) x multiplier + addAfter, then rounded.
 * Amounts are decimal text, never floating point numbers, so they survive storage exactly.
 * The usual formula: addBefore 0.00, multiplier 2, addAfter 1.00, rounded up to .99.
 * A vendor formula like (cost + 2.25) x 2: addBefore 2.25, multiplier 2, addAfter 0.00.
 */
export interface PriceFormula {
  addBefore: string;
  multiplier: string;
  addAfter: string;
  rounding: Rounding;
}

export interface VendorFormula {
  /**
   * The vendor name as typed in settings. Invoice vendor names will not always match it
   * (a short name in settings against the full company name on the invoice), so the matching
   * step will need a list of aliases per vendor. Not built yet.
   */
  vendor: string;
  formula: PriceFormula;
}

export interface PricingSettings {
  default: PriceFormula;
  vendors: VendorFormula[];
}

export interface SettingValues {
  anthropicFirstPassModel: string;
  anthropicFallbackModel: string;
  /** US dollars per invoice, decimal text. The most one invoice may cost to read, first pass and fallback together. A reading that would go over it stops and asks an admin first. */
  invoiceCostCapUsd: string;
  /** US dollars per invoice, decimal text. The most new card copy for one invoice may cost, apart from the reading. Past it, an admin approves the cards still waiting, all at once. */
  cardCopyCapUsd: string;
  /** US dollars, decimal text. The most all readings and card copy together may cost in any 24 hours. Past it, an admin approves. 0.00 asks an admin every time. */
  dailyLimitUsd: string;
  /** Whole percent from 10 to 100, as text. The part of the daily limit that readings of old invoices may use, so a backlog never blocks new invoices. */
  historySharePercent: string;
  /** Whole percent from 5 to 50, as text. A price moving more than this from today's Square price needs its own tick in review. */
  bigChangePercent: string;
  squareEnvironment: SquareEnvironment;
  squareLocationId: string;
  /** ScaleConnect's MCP address. The scale list itself is read from ScaleConnect, not stored here. */
  scaleConnectUrl: string;
  pricing: PricingSettings;
  /** Path to the card config JSON, for example config/cards/<store>.json. */
  cardConfigPath: string;
}

export type SettingName = keyof SettingValues;

export const SECRET_NAMES = ['anthropicApiKey', 'squareAccessToken', 'scaleConnectToken', 'mailchimpApiKey'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const SECRET_LABELS: Record<SecretName, string> = {
  anthropicApiKey: 'Claude API key',
  squareAccessToken: 'Square access token',
  scaleConnectToken: 'ScaleConnect token',
  mailchimpApiKey: 'Mailchimp API key',
};

export function isSecretName(v: string): v is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(v);
}

export const DEFAULT_FORMULA: PriceFormula = { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' };

export function defaultSettings(): SettingValues {
  return {
    anthropicFirstPassModel: 'claude-sonnet-5-5',
    anthropicFallbackModel: 'claude-opus-5-5',
    invoiceCostCapUsd: '1.00',
    cardCopyCapUsd: '5.00',
    dailyLimitUsd: '10.00',
    historySharePercent: '50',
    bigChangePercent: '30',
    squareEnvironment: 'sandbox',
    squareLocationId: '',
    scaleConnectUrl: '',
    pricing: { default: { ...DEFAULT_FORMULA }, vendors: [] },
    cardConfigPath: '',
  };
}

export const SETTING_NAMES: readonly SettingName[] = Object.keys(defaultSettings()) as SettingName[];

export function isSettingName(v: string): v is SettingName {
  return (SETTING_NAMES as readonly string[]).includes(v);
}

/** A value a person typed that cannot be used. The message is safe to show and never quotes a secret. */
export class SettingError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

const MONEY_RE = /^\d{1,4}(\.\d{1,2})?$/;
const MULT_RE = /^\d{1,2}(\.\d{1,3})?$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function money(field: string, raw: string): string {
  const v = raw.trim().replace(/^\$/, '');
  if (!MONEY_RE.test(v)) throw new SettingError(field, 'Enter an amount like 1.00.');
  return Number(v).toFixed(2);
}

/** A dollar amount inside a range, as 2-decimal text. */
function moneyBetween(field: string, raw: string, min: number, max: number): string {
  const v = money(field, raw);
  if (Number(v) < min || Number(v) > max) throw new SettingError(field, `Enter an amount from ${min.toFixed(2)} to ${max.toFixed(2)}.`);
  return v;
}

function multiplier(field: string, raw: string): string {
  const v = raw.trim();
  if (!MULT_RE.test(v) || Number(v) <= 0) throw new SettingError(field, 'Enter a multiplier like 2 or 2.5.');
  return v;
}

function rounding(field: string, raw: string): Rounding {
  const v = raw.trim() || 'up-to-99';
  if (!(ROUNDINGS as readonly string[]).includes(v)) throw new SettingError(field, 'Pick a rounding rule from the list.');
  return v as Rounding;
}

export function checkFormula(field: string, f: { addBefore: string; multiplier: string; addAfter: string; rounding: string }): PriceFormula {
  return {
    addBefore: money(field, f.addBefore),
    multiplier: multiplier(field, f.multiplier),
    addAfter: money(field, f.addAfter),
    rounding: rounding(field, f.rounding),
  };
}

function checkVendors(list: readonly { vendor: unknown; formula: unknown }[], where: (i: number) => string): VendorFormula[] {
  if (list.length > 200) throw new SettingError('pricingVendors', 'Too many vendor formulas. The limit is 200.');
  const seen = new Set<string>();
  return list.map((item, i) => {
    const vendor = typeof item.vendor === 'string' ? item.vendor.trim() : '';
    if (vendor.length < 1 || vendor.length > 100 || vendor.includes('|')) {
      throw new SettingError('pricingVendors', `${where(i)}: the vendor name is missing, too long or has a | in it.`);
    }
    // Folded the same way chooseFormula and supplier matching compare names (companyKey in
    // src/lib/names.ts), so two lines that differ only by case, spacing, quotes, accents or a
    // company ending such as Inc. cannot both be saved.
    const key = vendorKey(vendor);
    if (seen.has(key)) throw new SettingError('pricingVendors', `${where(i)}: ${vendor} is listed twice.`);
    seen.add(key);
    const f = item.formula as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') throw new SettingError('pricingVendors', `${where(i)}: the formula is missing.`);
    const text = (k: string): string => (typeof f[k] === 'string' ? (f[k] as string) : '');
    const formula = checkFormula('pricingVendors', {
      addBefore: text('addBefore'),
      multiplier: text('multiplier'),
      addAfter: text('addAfter'),
      rounding: text('rounding'),
    });
    return { vendor, formula };
  });
}

/**
 * Vendor formulas, one per line: Vendor name | add before | multiplier | add after
 * For example, one vendor uses (cost + 2.25) x 2: Example Cheese Co | 2.25 | 2 | 0.00
 */
export function parseVendorLines(text: string): VendorFormula[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const items = lines.map((line, i) => {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 4 || parts.length > 5) {
      throw new SettingError('pricingVendors', `Line ${i + 1}: use Vendor | add before | multiplier | add after.`);
    }
    return { vendor: parts[0], formula: { addBefore: parts[1], multiplier: parts[2], addAfter: parts[3], rounding: parts[4] ?? '' } };
  });
  return checkVendors(items, (i) => `Line ${i + 1}`);
}

/** One line per vendor, rounding included, so a save keeps it. */
export function vendorLines(vendors: readonly VendorFormula[]): string {
  return vendors.map((v) => [v.vendor, v.formula.addBefore, v.formula.multiplier, v.formula.addAfter, v.formula.rounding].join(' | ')).join('\n');
}

/**
 * The shelf price a formula gives for a cost, in cents, for the settings page example.
 * It calls the pricing module, so the example and real pricing can never disagree.
 */
export function exampleShelfCents(f: PriceFormula, cost: string): number {
  return shelfCentsForText(f, cost);
}

export function formatCents(c: number): string {
  return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** Checks and normalizes one non-secret value. Throws SettingError. */
export function checkSetting<K extends SettingName>(name: K, value: unknown, opts: { allowSquareProduction: boolean }): SettingValues[K] {
  const str = (v: unknown): string => {
    if (typeof v !== 'string') throw new SettingError(name, 'Expected text.');
    if (v.includes('\0')) throw new SettingError(name, 'That value has a character that is not allowed.');
    return v.trim();
  };
  switch (name) {
    case 'anthropicFirstPassModel':
    case 'anthropicFallbackModel': {
      const v = str(value);
      if (!MODEL_RE.test(v)) throw new SettingError(name, 'Enter a model name like claude-sonnet-5-5.');
      return v as SettingValues[K];
    }
    case 'invoiceCostCapUsd':
      return money(name, str(value)) as SettingValues[K];
    case 'cardCopyCapUsd':
      return moneyBetween(name, str(value), 0.01, 100) as SettingValues[K];
    case 'dailyLimitUsd':
      return moneyBetween(name, str(value), 0, 1000) as SettingValues[K];
    case 'historySharePercent': {
      const v = str(value);
      if (!/^\d{1,3}$/.test(v) || Number(v) < 10 || Number(v) > 100) throw new SettingError(name, 'Enter a whole number of percent from 10 to 100, like 50.');
      return String(Number(v)) as SettingValues[K];
    }
    case 'bigChangePercent': {
      const v = str(value);
      // At most 50, the level where the scales ask too. A limit of 100 or more could never flag a
      // price drop, since no price falls by more than 100 percent, so Bart's rule would do nothing.
      if (!/^\d{1,3}$/.test(v) || Number(v) < 5 || Number(v) > 50) throw new SettingError(name, 'Enter a whole number of percent from 5 to 50, like 30.');
      return String(Number(v)) as SettingValues[K];
    }
    case 'squareEnvironment': {
      const v = str(value);
      if (v !== 'sandbox' && v !== 'production') throw new SettingError(name, 'Pick sandbox or production.');
      if (v === 'production' && !opts.allowSquareProduction) {
        throw new SettingError(name, 'Production is locked in this install. It opens only after live Square is approved.');
      }
      return v as SettingValues[K];
    }
    case 'squareLocationId': {
      const v = str(value);
      if (v !== '' && (!/^[A-Za-z0-9]{4,32}$/.test(v) || v.startsWith('EAAA'))) {
        throw new SettingError(name, 'That does not look like a Square location id.');
      }
      return v as SettingValues[K];
    }
    case 'scaleConnectUrl': {
      const v = str(value);
      if (v === '') return v as SettingValues[K];
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        throw new SettingError(name, 'Enter a full address like http://127.0.0.1:8765/mcp.');
      }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) {
        throw new SettingError(name, 'Use an http or https address with no login, query or fragment in it.');
      }
      // Plain http sends the token unencrypted, so it may only go to this PC or the store's own
      // network. https may go anywhere.
      if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
        throw new SettingError(
          name,
          'A plain http address must be this PC (127.0.0.1) or an address on the store network (10.x, 172.16 to 172.31, 192.168/16, or Tailscale 100.64 to 100.127). Use https for anything else.',
        );
      }
      return u.href as SettingValues[K];
    }
    case 'cardConfigPath': {
      const v = str(value);
      if (v !== '' && (v.length > 500 || !v.endsWith('.json'))) throw new SettingError(name, 'Enter the path to a .json card config file.');
      return v as SettingValues[K];
    }
    case 'pricing': {
      const p = value as Partial<PricingSettings> | null;
      if (!p || typeof p !== 'object' || !p.default || !Array.isArray(p.vendors)) throw new SettingError(name, 'Pricing settings are incomplete.');
      const d = p.default as unknown as Record<string, unknown>;
      const text = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
      const def = checkFormula('pricingDefault', { addBefore: text('addBefore'), multiplier: text('multiplier'), addAfter: text('addAfter'), rounding: text('rounding') });
      const vendors = checkVendors(p.vendors, (i) => `Vendor ${i + 1}`);
      return { default: def, vendors } as SettingValues[K];
    }
    default:
      throw new SettingError(name, 'Unknown setting.');
  }
}

/**
 * True for loopback, the RFC 1918 private ranges and Tailscale's 100.64.0.0/10.
 * Link-local (169.254.x) is not allowed. Host names other than localhost are not allowed,
 * because where a name points can change.
 */
export function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Fills in anything a stored value lacks, so a field added in a later version is never undefined
 * when read from an older row.
 */
export function withDefaults<K extends SettingName>(name: K, stored: unknown): SettingValues[K] {
  const d = defaultSettings()[name];
  if (name === 'pricing') {
    const p = (stored ?? {}) as Partial<PricingSettings>;
    const dp = d as PricingSettings;
    const vendors = Array.isArray(p.vendors) ? p.vendors : [];
    return {
      ...dp,
      ...p,
      default: { ...dp.default, ...(p.default ?? {}) },
      vendors: vendors.map((v) => ({ ...v, formula: { ...DEFAULT_FORMULA, ...(v.formula ?? {}) } })),
    } as SettingValues[K];
  }
  if (typeof d === 'string') return (typeof stored === 'string' ? stored : d) as SettingValues[K];
  return stored as SettingValues[K];
}

/** Checks a secret's shape so a value pasted into the wrong box is caught. Throws SettingError. */
export function checkSecret(name: SecretName, value: string): string {
  const v = value.trim();
  const printable = /^[\x21-\x7e]+$/.test(v);
  if (name === 'squareAccessToken') {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(v)) throw new SettingError(name, 'That does not look like a Square access token.');
  } else if (name === 'mailchimpApiKey') {
    // 32 hex characters, a dash, then the data center the key belongs to, such as us7.
    if (!/^[0-9a-f]{32}-us[0-9]{1,3}$/.test(v)) throw new SettingError(name, 'That does not look like a Mailchimp API key.');
  } else if (!printable || v.length < 20 || v.length > 300) {
    throw new SettingError(name, `That does not look like a ${SECRET_LABELS[name]}.`);
  }
  return v;
}
