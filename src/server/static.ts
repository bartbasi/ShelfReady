// Static files for the app's own look: the stylesheet, the theme built from the branding config,
// the fonts and the tab icon. A fixed list of routes. Nothing is read from a path the browser picks.
// Everything is loaded once at start and held in memory (about a megabyte), and compressed the
// first time a browser asks, so the PC does the work once.
//
// The page links carry a version (?v=hash of the content), so browsers keep these files for a
// year and fetch them again only when the content changes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { iconSvg, loadFont, themeCss, type Branding, type FontKey, type LoadedFont } from './branding.ts';
import { REPO_ROOT } from './config.ts';
import type { Look } from './look.ts';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Font files may come only from these folders, after symlinks are resolved. */
const FONT_DIRS = [join(REPO_ROOT, 'src', 'server', 'static', 'fonts'), join(REPO_ROOT, 'config', 'local', 'fonts')];

/** The scripts a page may ask for, by name. A page cannot name any other. */
export const SCRIPTS = ['upload'] as const;
export type ScriptName = (typeof SCRIPTS)[number];

/**
 * The legal texts, served as plain text at fixed paths and read once at start. The About page
 * links to them. They are part of the software notice and branding cannot remove them.
 */
export const LEGAL_FILES: Record<string, string> = {
  '/legal/LICENSE': 'LICENSE',
  '/legal/NOTICE': 'NOTICE',
  '/legal/OFL-Fraunces.txt': 'src/server/static/fonts/OFL-Fraunces.txt',
  '/legal/OFL-SpaceGrotesk.txt': 'src/server/static/fonts/OFL-SpaceGrotesk.txt',
};

interface Asset {
  bytes: Buffer;
  /** Content hash. A link with this ?v= is safe to keep for a year. */
  version: string;
  type: string;
  /** Fonts are already compressed in WOFF2. Everything else is worth compressing. */
  compress: boolean;
}

const version = (b: Buffer): string => createHash('sha256').update(b).digest('hex').slice(0, 10);

export function registerStatic(app: FastifyInstance, branding: Branding, extraFontDirs: readonly string[] = []): Look {
  const fonts: LoadedFont[] = [];
  const specs: [FontKey, string][] = [
    ['display', branding.fonts.display.normal],
    ['display-italic', branding.fonts.display.italic],
    ['body', branding.fonts.body.normal],
    ['body-italic', branding.fonts.body.italic],
  ];
  for (const [key, path] of specs) if (path) fonts.push(loadFont(key, path, [...FONT_DIRS, ...extraFontDirs]));

  const css = readFileSync(new URL('./static/app.css', import.meta.url));
  const theme = Buffer.from(themeCss(branding, fonts));
  const icon = Buffer.from(iconSvg(branding));

  const assets = new Map<string, Asset>();
  assets.set('/static/app.css', { version: version(css), bytes: css, type: 'text/css; charset=utf-8', compress: true });
  assets.set('/static/theme.css', { version: version(theme), bytes: theme, type: 'text/css; charset=utf-8', compress: true });
  assets.set('/static/icon.svg', { version: version(icon), bytes: icon, type: 'image/svg+xml', compress: true });
  for (const f of fonts) {
    // A TTF or OTF is worth compressing. WOFF and WOFF2 are already.
    assets.set(`/static/fonts/${f.key}`, { version: f.version, bytes: f.bytes, type: f.mime, compress: f.format === 'truetype' || f.format === 'opentype' });
  }

  // The few scripts, all progressive: every page works without them. Fixed names, read once.
  const scriptVersions: Record<string, string> = {};
  for (const name of SCRIPTS) {
    const bytes = readFileSync(new URL(`./static/js/${name}.js`, import.meta.url));
    scriptVersions[name] = version(bytes);
    assets.set(`/static/js/${name}.js`, { version: version(bytes), bytes, type: 'text/javascript; charset=utf-8', compress: true });
  }

  const packed = new Map<string, Promise<Buffer>>();
  const pack = (url: string, enc: 'br' | 'gzip', a: Asset): Promise<Buffer> => {
    const k = `${url} ${enc}`;
    let p = packed.get(k);
    if (!p) {
      p = enc === 'br' ? brotli(a.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: a.bytes.length } }) : gz(a.bytes, { level: 9 });
      // A failed compression is not kept, so the next request tries again.
      p.catch(() => packed.delete(k));
      packed.set(k, p);
    }
    return p;
  };

  const serve = (url: string, a: Asset) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      // A year, but only for a link that names this exact content. Any other ?v= gets five minutes.
      const v = (req.query as Record<string, unknown> | undefined)?.v;
      reply.header('Cache-Control', v === a.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
      reply.header('Vary', 'Accept-Encoding');
      reply.type(a.type);
      if (a.compress) {
        const enc = chooseEncoding(String(req.headers['accept-encoding'] ?? ''));
        if (enc) {
          try {
            const body = await pack(url, enc, a);
            reply.header('Content-Encoding', enc);
            return reply.send(body);
          } catch {
            // Fall through and send the file as it is.
          }
        }
      }
      return reply.send(a.bytes);
    };

  for (const [url, a] of assets) app.get(url, { config: { access: 'public' } }, serve(url, a));

  const legal = new Map<string, Buffer>();
  for (const [url, rel] of Object.entries(LEGAL_FILES)) {
    try {
      legal.set(url, readFileSync(join(REPO_ROOT, rel)));
    } catch {
      throw new Error(`The legal file ${rel} is missing. The About page links to it.`);
    }
  }
  for (const [url, bytes] of legal) {
    app.get(url, { config: { access: 'public' } }, async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.type('text/plain; charset=utf-8').send(bytes);
    });
  }

  return { branding, cssVersion: version(css), themeVersion: version(theme), iconVersion: version(icon), scriptVersions };
}

/** The encoding to use, from Accept-Encoding, honouring q=0 as "not acceptable". Brotli first. */
export function chooseEncoding(header: string): 'br' | 'gzip' | null {
  const q = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number.parseFloat(m[1]);
    }
    q.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  if ((q.get('br') ?? 0) > 0) return 'br';
  if ((q.get('gzip') ?? 0) > 0) return 'gzip';
  return null;
}
