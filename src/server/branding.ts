// How the app looks and what it calls itself. All of it comes from the `branding` block of the
// server config, or the branding file the config names, so a store rebrands without touching
// code. The defaults here are neutral: no store name, no tagline, a plain palette and the fonts
// that come with the app. This install's look is in config/branding/cheese-and-crackers.json.
// The app's own styling is separate from the shelf card design, which lives in the card config.
//
// What branding cannot change: the software notice on the About page (see NOTICE, section 7).
//
// Everything here ends up in CSS or HTML, so every value is checked against a strict pattern.
// A colour is #rrggbb, a font family is letters, digits and spaces, and text has no control
// characters. Nothing here is ever taken from a browser.

import { createHash } from 'node:crypto';
import { readFileUnder, SafeFileError } from './safe-file.ts';
import { escapeHtml } from './views/html.ts';

export interface BrandColors {
  /** Page background. */
  bg: string;
  /** Slightly lighter than bg, for form fields and cards. */
  paper: string;
  /** Text, rules and the dark blocks. */
  ink: string;
  red: string;
  redDark: string;
  yellow: string;
  yellowDark: string;
  /** Hairlines. Never used for text. */
  inkFaint: string;
  /** Secondary text. Must read on bg. */
  inkMid: string;
}

export interface FontSpec {
  /** The CSS font-family name. */
  family: string;
  /** Font file, TTF, OTF, WOFF or WOFF2. Relative paths start at the repo root. */
  normal: string;
  /** Optional italic file. Without it the browser slants the normal one. */
  italic: string;
  /** The weights the file covers, like "300 900" for a variable font or "400" for one weight. */
  weights: string;
}

export interface Branding {
  /** What the app calls itself in the title and the header. */
  appName: string;
  /** The store's name, in the footer and above page titles. May be empty. */
  storeName: string;
  /** One to four characters in the black block of the header. */
  logoMark: string;
  /** May be empty. */
  tagline: string;
  /** The store's own line in the footer. May be empty. It is not the software notice. */
  footerLine: string;
  colors: BrandColors;
  fonts: { display: FontSpec; body: FontSpec };
}

export interface BrandingInput {
  appName?: string;
  storeName?: string;
  logoMark?: string;
  tagline?: string;
  footerLine?: string;
  colors?: Partial<BrandColors>;
  fonts?: { display?: Partial<FontSpec>; body?: Partial<FontSpec> };
}

export function defaultBranding(): Branding {
  return {
    appName: 'ShelfReady',
    storeName: '',
    logoMark: 'SR',
    tagline: '',
    footerLine: '',
    colors: {
      bg: '#f6f6f3',
      paper: '#ffffff',
      ink: '#1a1a1a',
      red: '#b3261e',
      redDark: '#8c1d17',
      yellow: '#f0c93f',
      yellowDark: '#d9b230',
      inkFaint: '#d3d3cd',
      inkMid: '#4a4a46',
    },
    fonts: {
      display: {
        family: 'Fraunces',
        normal: 'src/server/static/fonts/Fraunces.ttf',
        italic: 'src/server/static/fonts/Fraunces-Italic.ttf',
        weights: '300 900',
      },
      body: { family: 'Space Grotesk', normal: 'src/server/static/fonts/SpaceGrotesk.ttf', italic: '', weights: '300 700' },
    },
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/;
const WEIGHTS = /^[1-9]00( [1-9]00)?$/;
// Printable text only: no control or format characters, no angle brackets (they are escaped anyway).
const TEXT = /^[^\p{C}\p{Zl}\p{Zp}<>]+$/u;
const MARK = /^[A-Za-z0-9&+ ]{1,4}$/;
const MAX_FONT_BYTES = 2 * 1024 * 1024;

function text(name: string, v: unknown, max: number, optional = false): string {
  if (optional && v === '') return '';
  if (typeof v !== 'string' || v.trim() === '' || v.length > max || !TEXT.test(v)) {
    throw new Error(`branding.${name} must be plain text of ${optional ? '0' : '1'} to ${max} characters.`);
  }
  return v.trim();
}

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text and background pairs the stylesheet uses. Each needs WCAG AA (4.5 to 1) for text. */
export const COLOR_PAIRS: readonly (readonly [string, keyof BrandColors, keyof BrandColors])[] = [
  ['ink on bg', 'ink', 'bg'],
  ['ink on paper', 'ink', 'paper'],
  ['secondary text on bg', 'inkMid', 'bg'],
  ['secondary text on paper', 'inkMid', 'paper'],
  ['secondary text on yellow', 'inkMid', 'yellow'],
  ['disabled button text', 'inkMid', 'inkFaint'],
  ['red on bg', 'red', 'bg'],
  ['red on paper', 'red', 'paper'],
  ['bg on ink', 'bg', 'ink'],
  ['bg on red', 'bg', 'red'],
  ['bg on dark red', 'bg', 'redDark'],
  ['ink on yellow', 'ink', 'yellow'],
  ['ink on dark yellow', 'ink', 'yellowDark'],
  ['yellow on ink', 'yellow', 'ink'],
];

/** Merges the input over the defaults and checks it. Throws with a plain message. */
export function makeBranding(input: BrandingInput | undefined, resolvePath: (p: string) => string): Branding {
  const d = defaultBranding();
  const i = input ?? {};
  const b: Branding = {
    appName: text('appName', i.appName ?? d.appName, 40),
    storeName: text('storeName', i.storeName ?? d.storeName, 60, true),
    logoMark: i.logoMark ?? d.logoMark,
    tagline: text('tagline', i.tagline ?? d.tagline, 100, true),
    footerLine: text('footerLine', i.footerLine ?? d.footerLine, 200, true),
    colors: { ...d.colors, ...i.colors },
    fonts: {
      display: { ...d.fonts.display, ...i.fonts?.display },
      body: { ...d.fonts.body, ...i.fonts?.body },
    },
  };
  if (typeof b.logoMark !== 'string' || !MARK.test(b.logoMark)) throw new Error('branding.logoMark must be 1 to 4 letters or digits.');
  for (const [k, v] of Object.entries(b.colors)) {
    if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`branding.colors.${k} must be a colour like #1a2b3c.`);
    (b.colors as unknown as Record<string, string>)[k] = v.toLowerCase();
  }
  for (const [label, fg, bg] of COLOR_PAIRS) {
    if (contrastRatio(b.colors[fg], b.colors[bg]) < 4.5) {
      throw new Error(`branding.colors: ${label} is too faint to read. It needs a contrast of at least 4.5 to 1.`);
    }
  }
  for (const role of ['display', 'body'] as const) {
    const f = b.fonts[role];
    if (typeof f.family !== 'string' || !FAMILY.test(f.family)) throw new Error(`branding.fonts.${role}.family must be letters, digits and spaces.`);
    if (typeof f.weights !== 'string' || !WEIGHTS.test(f.weights)) throw new Error(`branding.fonts.${role}.weights must look like "400" or "300 900".`);
    if (typeof f.normal !== 'string' || f.normal === '') throw new Error(`branding.fonts.${role}.normal must be a font file.`);
    if (typeof f.italic !== 'string') throw new Error(`branding.fonts.${role}.italic must be a font file or empty.`);
    f.normal = resolvePath(f.normal);
    if (f.italic) f.italic = resolvePath(f.italic);
  }
  return b;
}

export type FontKey = 'display' | 'display-italic' | 'body' | 'body-italic';

export interface LoadedFont {
  key: FontKey;
  bytes: Buffer;
  mime: string;
  format: 'woff2' | 'woff' | 'truetype' | 'opentype';
  version: string;
}

/**
 * Reads a font file once. The real path (symlinks resolved) must sit inside one of the allowed
 * folders. The file must be a regular file of a sane size, read to its full length, and must have
 * the structure of a font: a sfnt table directory with a head table (magic 0x5F0F3CF5) for TTF and
 * OTF, or a WOFF or WOFF2 header whose length field equals the file size.
 */
export function loadFont(key: FontKey, path: string, allowedDirs: readonly string[]): LoadedFont {
  const bad = (why: string): Error => new Error(`The font file for branding (${key}) ${why}.`);
  let bytes: Buffer;
  try {
    bytes = readFileUnder(path, allowedDirs, { min: 1024, max: MAX_FONT_BYTES }).bytes;
  } catch (err) {
    if (!(err instanceof SafeFileError)) throw err;
    throw bad(
      { unreadable: `cannot be read at ${path}`, outside: 'must be inside src/server/static/fonts or config/local/fonts', 'not-a-file': 'is not a regular file', size: 'must be between 1 KB and 2 MB', changed: 'changed while it was being read' }[err.problem],
    );
  }
  const magic = bytes.subarray(0, 4).toString('latin1');
  let format: LoadedFont['format'];
  let mime: string;
  if (magic === 'wOF2' || magic === 'wOFF') {
    if (bytes.readUInt32BE(8) !== bytes.length) throw bad('has a header that does not match its size');
    [format, mime] = magic === 'wOF2' ? ['woff2', 'font/woff2'] : ['woff', 'font/woff'];
  } else if (magic === 'OTTO' || bytes.readUInt32BE(0) === 0x00010000 || magic === 'true') {
    if (!hasHeadTable(bytes)) throw bad('does not have the table directory of a font');
    [format, mime] = magic === 'OTTO' ? ['opentype', 'font/otf'] : ['truetype', 'font/ttf'];
  } else throw bad('is not a TTF, OTF, WOFF or WOFF2 font');
  return { key, bytes, mime, format, version: createHash('sha256').update(bytes).digest('hex').slice(0, 10) };
}

/** True when the sfnt table directory is inside the file and has a head table with the right magic. */
function hasHeadTable(b: Buffer): boolean {
  if (b.length < 12) return false;
  const n = b.readUInt16BE(4);
  if (n === 0 || n > 64 || 12 + 16 * n > b.length) return false;
  for (let i = 0; i < n; i++) {
    const rec = 12 + 16 * i;
    if (b.subarray(rec, rec + 4).toString('latin1') !== 'head') continue;
    const off = b.readUInt32BE(rec + 8);
    const len = b.readUInt32BE(rec + 12);
    return len >= 54 && off + len <= b.length && b.readUInt32BE(off + 12) === 0x5f0f3cf5;
  }
  return false;
}

export const fontUrl = (f: LoadedFont): string => `/static/fonts/${f.key}?v=${f.version}`;

/**
 * The theme: colours and fonts as CSS variables and @font-face rules. The font URLs are fixed
 * same-origin paths. Nothing in it comes from a browser.
 */
export function themeCss(b: Branding, fonts: readonly LoadedFont[]): string {
  const c = b.colors;
  const face = (family: string, f: LoadedFont, weights: string, style: 'normal' | 'italic'): string =>
    `@font-face{font-family:"${family}";src:url("${fontUrl(f)}") format("${f.format}");font-weight:${weights};font-style:${style};font-display:swap}`;
  const out: string[] = [
    `:root{--bg:${c.bg};--paper:${c.paper};--ink:${c.ink};--red:${c.red};--red-dark:${c.redDark};--yellow:${c.yellow};--yellow-dark:${c.yellowDark};--ink-faint:${c.inkFaint};--ink-mid:${c.inkMid};` +
      `--font-display:"${b.fonts.display.family}",Georgia,"Times New Roman",serif;--font-body:"${b.fonts.body.family}",system-ui,-apple-system,"Segoe UI",sans-serif}`,
  ];
  const by = new Map(fonts.map((f) => [f.key, f]));
  for (const role of ['display', 'body'] as const) {
    const spec = b.fonts[role];
    const normal = by.get(role);
    const italic = by.get(`${role}-italic` as FontKey);
    if (normal) out.push(face(spec.family, normal, spec.weights, 'normal'));
    if (italic) out.push(face(spec.family, italic, spec.weights, 'italic'));
  }
  return out.join('\n') + '\n';
}

/** The tab icon: the logo block in the brand colours. Drawn with an SVG, so no image file is needed. */
export function iconSvg(b: Branding): string {
  const mark = escapeHtml(b.logoMark);
  const size = b.logoMark.length <= 2 ? 30 : b.logoMark.length === 3 ? 24 : 19;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeHtml(b.appName)}"><rect width="64" height="64" fill="${b.colors.ink}"/><rect x="0" y="54" width="64" height="10" fill="${b.colors.red}"/><text x="32" y="40" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${size}" text-anchor="middle" fill="${b.colors.bg}">${mark}</text></svg>\n`;
}
