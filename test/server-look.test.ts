import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { ADMIN_PW, MANAGER_PW, ORIGIN, addUser, get, login, makeApp, tempDir } from './server-helpers.ts';
import { COLOR_PAIRS, contrastRatio, defaultBranding, makeBranding } from '../src/server/branding.ts';
import { loadConfig, makeConfig, REPO_ROOT } from '../src/server/config.ts';
import { LEGAL_FILES, chooseEncoding } from '../src/server/static.ts';
import { neutralLook } from '../src/server/look.ts';
import { SOFTWARE_NOTICE, dryRunBanner, dryRunTag, layout, liveBanner } from '../src/server/views/pages.ts';
import { html } from '../src/server/views/html.ts';

const abs = (p: string): string => (p.startsWith('/') ? p : join(REPO_ROOT, p));

test('pages link the stylesheets and icon from this origin, and fonts are served from here', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const page = (await get(s, '/login')).body;
  assert.match(page, /<link rel="stylesheet" href="\/static\/theme\.css\?v=[0-9a-f]{10}">/);
  assert.match(page, /<link rel="stylesheet" href="\/static\/app\.css\?v=[0-9a-f]{10}">/);
  assert.match(page, /<link rel="icon" href="\/static\/icon\.svg\?v=[0-9a-f]{10}"/);
  // Every resource a page loads is a path on this origin.
  for (const m of page.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)) assert.match(m[1], /^\/static\//, m[1]);

  const theme = await get(s, '/static/theme.css');
  assert.equal(theme.statusCode, 200);
  assert.match(String(theme.headers['content-type']), /text\/css/);
  assert.doesNotMatch(theme.body, /https?:|\/\/|@import/, 'no other origin in the theme');
  assert.match(theme.body, /font-family:"Fraunces"/);
  assert.match(theme.body, /font-family:"Space Grotesk"/);
  const urls = [...theme.body.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 3, 'the display font, its italic and the body font');
  for (const u of urls) {
    assert.match(u, /^\/static\/fonts\/[a-z-]+\?v=[0-9a-f]{10}$/);
    const f = await get(s, u);
    assert.equal(f.statusCode, 200, u);
    assert.equal(f.headers['content-type'], 'font/ttf');
    assert.match(String(f.headers['cache-control']), /max-age=31536000, immutable/);
    assert.equal(f.rawPayload.readUInt32BE(0), 0x00010000, 'a TrueType file');
  }
  // The stylesheet itself names no colour and no font: those come from the branding config.
  const css = readFileSync(new URL('../src/server/static/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'colours belong in the branding config');
  assert.doesNotMatch(css, /Fraunces|Space Grotesk/, 'font names belong in the branding config');
  assert.doesNotMatch(css, /https?:|@import|url\(/, 'no outside file in the stylesheet');
  assert.equal((await get(s, '/static/app.css')).body, css);
});

test('fonts and the stylesheet are compressed on request, and served as they are otherwise', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const raw = await s.app.inject({ method: 'GET', url: '/static/fonts/body' });
  assert.equal(raw.headers['content-encoding'], undefined);
  const br = await s.app.inject({ method: 'GET', url: '/static/fonts/body', headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.ok(br.rawPayload.length < raw.rawPayload.length * 0.6);
  assert.deepEqual(brotliDecompressSync(br.rawPayload), raw.rawPayload);
  const css = await s.app.inject({ method: 'GET', url: '/static/app.css', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(css.headers['content-encoding'], 'gzip');
  // Only the fixed names are served.
  assert.equal((await get(s, '/static/fonts/../../config.ts')).statusCode, 404);
  assert.equal((await get(s, '/static/fonts/secret')).statusCode, 404);
  assert.equal((await get(s, '/static/fonts/body-italic')).statusCode, 404, 'no italic file is configured for the body');
});

test('the page style stays inside the CSP: no inline style or script on any page, in any mode', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW)).cookie;
  const bodies = [];
  for (const url of ['/login', '/about', '/', '/settings', '/users', '/account', '/nope', '/runs', '/runs/new']) {
    const res = await get(s, url, url === '/login' ? '' : cookie);
    bodies.push([url, res.body]);
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /style-src 'self'(;|$)/, url);
    assert.match(csp, /font-src 'self'(;|$)/, url);
    assert.match(csp, /script-src 'self'(;|$)/, url);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/, url);
  }
  bodies.push(['dry run', layout({ title: 'Check', mode: 'dry-run', body: html`<p>x</p>` })]);
  bodies.push(['live', layout({ title: 'Check', mode: 'live', body: html`<p>x</p>` })]);
  for (const [name, body] of bodies) {
    // The only script allowed is a file served from this app.
    assert.doesNotMatch(body.replace(/<script src="\/static\/js\/[a-z]+\.js\?v=[0-9a-f]{10}" defer><\/script>/g, ''), /<script|<style|\sstyle=|\son[a-z]+=|javascript:/i, name);
    assert.doesNotMatch(body, /<link[^>]+(?:href|src)="https?:/i, name);
  }
});

test('page words use no em dashes and no double hyphens', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW)).cookie;
  for (const url of ['/login', '/about', '/', '/settings', '/users', '/account', '/nope']) {
    const body = (await get(s, url, url === '/login' ? '' : cookie)).body;
    assert.doesNotMatch(body, /—|–|--/, url);
  }
});

test('a manager sees no admin links, an admin sees them, and each is told which role they have', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const admin = (await login(s, 'bart', ADMIN_PW)).cookie;
  const mgr = (await login(s, 'mgr', MANAGER_PW)).cookie;
  for (const url of ['/', '/runs', '/account', '/about', '/nope']) {
    const m = (await get(s, url, mgr)).body;
    assert.doesNotMatch(m, /href="\/settings"|href="\/users"/, `manager on ${url}`);
    assert.match(m, /role role-manager">Manager</, `manager on ${url}`);
    const a = (await get(s, url, admin)).body;
    assert.match(a, /href="\/settings"/, `admin on ${url}`);
    assert.match(a, /href="\/users"/, `admin on ${url}`);
    assert.match(a, /role role-admin">Admin</, `admin on ${url}`);
  }
  const home = (await get(s, '/', mgr)).body;
  assert.match(home, /href="\/runs\/new"/);
  assert.doesNotMatch(home, /Admin only/);
  assert.match((await get(s, '/', admin)).body, /Admin only/);
  // The page you are on is marked in the menu, for screen readers too.
  assert.match((await get(s, '/settings', admin)).body, /href="\/settings" aria-current="page"/);
  assert.match((await get(s, '/', mgr)).body, /href="\/" aria-current="page"/);
  // Sign out is a post with the token, never a link.
  assert.match(home, /<form method="post" action="\/logout">.*name="_csrf"/s);
});

test('every form field on the non-run pages has a label', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const admin = (await login(s, 'bart', ADMIN_PW)).cookie;
  for (const url of ['/login', '/account', '/settings', '/users']) {
    const body = (await get(s, url, url === '/login' ? '' : admin)).body;
    for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const a = m[2];
      if (/type="(hidden|checkbox)"/.test(a) && /type="hidden"/.test(a)) continue;
      const id = /\bid="([^"]+)"/.exec(a)?.[1];
      const labelled = /aria-label="/.test(a) || (id !== undefined && body.includes(`for="${id}"`)) || /type="checkbox"/.test(a);
      assert.ok(labelled, `${url}: ${m[0]}`);
    }
  }
});

test('the dry run banner is loud, shared, and kept off other pages', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const dry = layout({ title: 'Check', mode: 'dry-run', body: html`<p>x</p>` });
  assert.match(dry, /<body class="mode-dry-run">/);
  assert.match(dry, /<div class="banner banner-dry" role="status"><p class="banner-label">DRY RUN<\/p><p class="banner-text">Nothing is sent to Square or the scales\.<\/p><\/div>/);
  assert.match(dry, /<title>DRY RUN: Check \| ShelfReady<\/title>/);
  assert.equal(dry.match(/DRY RUN<\/p>/g)?.length, 1, 'one banner');
  const live = layout({ title: 'Check', mode: 'live', body: html`<p>x</p>` });
  assert.match(live, /banner-live/);
  assert.match(live, /<title>LIVE: Check \| ShelfReady<\/title>/);
  assert.doesNotMatch(live, /DRY RUN/);
  const plain = layout({ title: 'Check', body: html`<p>x</p>` });
  assert.doesNotMatch(plain, /DRY RUN|banner|mode-/);
  // The pieces a run page can place itself are escaped like everything else.
  assert.match(dryRunBanner('Look <b>here</b>').value, /Look &lt;b&gt;here&lt;\/b&gt;/);
  assert.match(liveBanner().value, /LIVE/);
  assert.match(dryRunTag().value, /tag tag-dry">DRY RUN</);
  // The stylesheet has the rules the markup needs.
  const css = readFileSync(new URL('../src/server/static/app.css', import.meta.url), 'utf8');
  for (const sel of ['.banner-dry', '.banner-live', '.mode-dry-run::after', '.tag-dry']) assert.ok(css.includes(sel), sel);
});

test('the code defaults are neutral: no store name, no tagline, a plain palette', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const b = s.config.branding;
  assert.equal(b.storeName, '');
  assert.equal(b.tagline, '');
  assert.equal(b.footerLine, '');
  assert.equal(b.appName, 'ShelfReady');
  const login = (await get(s, '/login')).body;
  assert.doesNotMatch(login, /Cheese|Crackers|C&amp;C|Real food/);
  assert.match(login, /class="logo"[^>]*>SR</);
  for (const f of ['../src/server/branding.ts', '../src/server/views/pages.ts', '../src/server/static/app.css']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8').replace(/Copyright 2026 Cheese & Crackers, Inc\.'/, ''), /Crackers|Real food, really|#c82c2c|#e8c840|#f5f2eb/, `${f} holds store branding`);
  }
});

test('this install\'s Deli Culture look comes from config/branding/cheese-and-crackers.json', async (t) => {
  const file = join(REPO_ROOT, 'config', 'branding', 'cheese-and-crackers.json');
  assert.ok(existsSync(file));
  // loadConfig picks the file up by default when nothing else is named.
  const dir = tempDir();
  writeFileSync(join(dir, 'server.json'), '{}');
  const c = loadConfig(join(dir, 'server.json'));
  assert.equal(c.branding.storeName, 'Cheese & Crackers');
  assert.equal(c.branding.logoMark, 'C&C');
  assert.equal(c.branding.tagline, 'Real food, really good.');
  assert.equal(c.branding.colors.red, '#c82c2c');
  assert.equal(c.branding.colors.yellow, '#e8c840');
  assert.equal(c.branding.fonts.display.family, 'Fraunces');
  assert.equal(c.branding.fonts.body.family, 'Space Grotesk');
  // A branding block in the config wins over the file, field by field.
  writeFileSync(join(dir, 'over.json'), JSON.stringify({ branding: { tagline: 'Hello.', colors: { red: '#aa2222' } } }));
  const o = loadConfig(join(dir, 'over.json'));
  assert.equal(o.branding.tagline, 'Hello.');
  assert.equal(o.branding.colors.red, '#aa2222');
  assert.equal(o.branding.colors.yellow, '#e8c840');
  // And the app shows it.
  const s = await makeApp({ brandingFile: file });
  t.after(() => s.close());
  const login = (await get(s, '/login')).body;
  assert.match(login, /Real food, really good\./);
  assert.match(login, /class="logo"[^>]*>C&amp;C</);
  assert.match((await get(s, '/static/theme.css')).body, /--red:#c82c2c;/);
  assert.match(login, /<p class="foot-store">Cheese &amp; Crackers<\/p>/);
});

test('branding comes from the config: name, colours, tagline and fonts', async (t) => {
  const s = await makeApp({
    branding: {
      appName: 'ShelfHand',
      storeName: 'Example Grocer',
      logoMark: 'EG',
      tagline: 'Fresh every day.',
      footerLine: 'Example Grocer, 1 Main Street',
      colors: { red: '#1F5FA8', redDark: '#174A85', bg: '#FFFFFF', paper: '#FAFAFA' },
    },
  });
  t.after(() => s.close());
  const login = (await get(s, '/login')).body;
  assert.match(login, /<title>Sign in \| ShelfHand<\/title>/);
  assert.match(login, /class="logo"[^>]*>EG</);
  assert.match(login, /class="wordmark" href="\/">ShelfHand</);
  assert.match(login, /Example Grocer/);
  assert.match(login, /Fresh every day\./);
  assert.match(login, /Example Grocer, 1 Main Street/);
  assert.match(login, /<meta name="theme-color" content="#1a1a1a">/);
  assert.doesNotMatch(login, /Cheese|Crackers|Real food/);
  const theme = (await get(s, '/static/theme.css')).body;
  assert.match(theme, /--red:#1f5fa8;/, 'colours are lower-cased');
  assert.match(theme, /--bg:#ffffff;/);
  assert.match(theme, /--ink:#1a1a1a;/, 'colours left out keep the default');
  const icon = (await get(s, '/static/icon.svg')).body;
  assert.match(icon, />EG<\/text>/);
});

test('the software notice on About comes from code: custom branding cannot change or remove it', async (t) => {
  assert.equal(SOFTWARE_NOTICE, 'ShelfReady. Designed and written by Bart Basi, with assistance from Claude. Copyright 2026 Cheese & Crackers, Inc.');
  for (const branding of [
    {},
    { appName: 'ShelfHand', storeName: 'Example Grocer', tagline: 'Fresh.', footerLine: 'Copyright someone else', logoMark: 'EG' },
  ]) {
    const s = await makeApp({ branding });
    const about = (await get(s, '/about')).body;
    assert.ok(about.includes('ShelfReady. Designed and written by Bart Basi, with assistance from Claude. Copyright 2026 Cheese &amp; Crackers, Inc.'), JSON.stringify(branding));
    assert.match(about, /GNU General Public License, version 3/);
    for (const href of ['/legal/LICENSE', '/legal/NOTICE', '/legal/OFL-Fraunces.txt', '/legal/OFL-SpaceGrotesk.txt']) {
      assert.ok(about.includes(`href="${href}"`), href);
    }
    // The store's own line is added, never swapped in for the notice.
    if ('footerLine' in branding) assert.match(about, /Copyright someone else/);
    await s.close();
  }
});

test('LICENSE, NOTICE and the font licenses are public plain text at fixed paths', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  assert.deepEqual(Object.keys(LEGAL_FILES).sort(), ['/legal/LICENSE', '/legal/NOTICE', '/legal/OFL-Fraunces.txt', '/legal/OFL-SpaceGrotesk.txt']);
  for (const [url, rel] of Object.entries(LEGAL_FILES)) {
    const res = await get(s, url); // no sign in
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.body, readFileSync(join(REPO_ROOT, rel), 'utf8'), url);
  }
  assert.match((await get(s, '/legal/NOTICE')).body, /Additional terms \(GNU General Public License, version 3, section 7\)/);
  assert.match((await get(s, '/legal/LICENSE')).body, /GNU GENERAL PUBLIC LICENSE/);
  assert.equal((await get(s, '/legal/../package.json')).statusCode, 404);
  assert.equal((await get(s, '/legal/other')).statusCode, 404);
});

test('two apps in one process each keep their own look, whatever the order', async (t) => {
  const a = await makeApp({ branding: { appName: 'Alpha', logoMark: 'AA' } });
  const b = await makeApp({ branding: { appName: 'Beta', logoMark: 'BB' } });
  t.after(async () => {
    await a.close();
    await b.close();
  });
  const urls = ['/login', '/about', '/nope'];
  const results = await Promise.all(urls.flatMap((u) => [get(a, u), get(b, u), get(a, u), get(b, u)]));
  results.forEach((r, i) => {
    const alpha = i % 2 === 0;
    assert.match(r.body, alpha ? /\| Alpha<\/title>/ : /\| Beta<\/title>/);
    assert.doesNotMatch(r.body, alpha ? /Beta/ : /Alpha/);
  });
  // A page rendered outside any request gets the neutral look, or the look it is handed.
  assert.match(layout({ title: 'T', body: html`<p>x</p>` }), /\| ShelfReady<\/title>/);
  const look = neutralLook();
  look.branding.appName = 'Given';
  assert.match(layout({ title: 'T', look, body: html`<p>x</p>` }), /\| Given<\/title>/);
});

test('a version in a link earns a year of caching only when it is the file\'s own', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const page = (await get(s, '/login')).body;
  const v = /app\.css\?v=([0-9a-f]{10})/.exec(page)![1];
  assert.match(String((await get(s, `/static/app.css?v=${v}`)).headers['cache-control']), /immutable/);
  for (const q of ['?v=bogus', '?v=0000000000', '', '?v=' + v + 'x']) {
    const c = String((await get(s, `/static/app.css${q}`)).headers['cache-control']);
    assert.doesNotMatch(c, /immutable|31536000/, q);
  }
});

test('Accept-Encoding is honoured, q=0 included', async (t) => {
  assert.equal(chooseEncoding('gzip, deflate, br'), 'br');
  assert.equal(chooseEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(chooseEncoding('br;q=0.0, gzip;q=0'), null);
  assert.equal(chooseEncoding('gzip;q=0.5'), 'gzip');
  assert.equal(chooseEncoding('identity'), null);
  assert.equal(chooseEncoding(''), null);
  assert.equal(chooseEncoding('BR ; Q=1'), 'br');
  const s = await makeApp();
  t.after(() => s.close());
  const r = await s.app.inject({ method: 'GET', url: '/static/app.css', headers: { 'accept-encoding': 'br;q=0, gzip' } });
  assert.equal(r.headers['content-encoding'], 'gzip');
  const n = await s.app.inject({ method: 'GET', url: '/static/app.css', headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } });
  assert.equal(n.headers['content-encoding'], undefined);
});

test('static and legal files skip the session lookup, pages do not', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const headers = { cookie: 'sr_session=not-a-real-session' };
  for (const url of ['/static/app.css', '/static/theme.css', '/legal/NOTICE']) {
    const r = await s.app.inject({ method: 'GET', url, headers });
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers['set-cookie'], undefined, `${url} looked at the session`);
  }
  const page = await s.app.inject({ method: 'GET', url: '/about', headers });
  assert.ok(page.headers['set-cookie'], 'a page clears the bad cookie, so it did look');
});

function woff2(extra = 2000): Buffer {
  const b = Buffer.alloc(12 + extra, 7);
  b.write('wOF2', 0, 'latin1');
  b.writeUInt32BE(b.length, 8);
  return b;
}

test('a store can bring its own fonts, and they are served the same way', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'display.woff2');
  const fake = woff2();
  writeFileSync(file, fake);
  const s = await makeApp({ branding: { fonts: { display: { family: 'Example Serif', normal: file, italic: '', weights: '400 700' } } } }, { extraFontDirs: [dir] });
  t.after(() => s.close());
  const theme = (await get(s, '/static/theme.css')).body;
  assert.match(theme, /font-family:"Example Serif";src:url\("\/static\/fonts\/display\?v=[0-9a-f]{10}"\) format\("woff2"\);font-weight:400 700;font-style:normal/);
  assert.doesNotMatch(theme, /Fraunces/);
  const f = await s.app.inject({ method: 'GET', url: '/static/fonts/display', headers: { 'accept-encoding': 'br' } });
  assert.equal(f.headers['content-type'], 'font/woff2');
  assert.equal(f.headers['content-encoding'], undefined, 'WOFF2 is already compressed');
  assert.deepEqual(f.rawPayload, fake);
  assert.equal((await get(s, '/static/fonts/display-italic')).statusCode, 404);
});

test('font files must sit in the font folders and have the structure of a font', async () => {
  const allowed = tempDir();
  const outside = tempDir();
  const deps = { extraFontDirs: [allowed] };
  const tryFont = (path: string): Promise<unknown> => makeApp({ branding: { fonts: { body: { normal: path } } } }, deps);
  // A good font outside the folder, a symlink inside it that points outside, and dot segments.
  writeFileSync(join(outside, 'ok.woff2'), woff2());
  await assert.rejects(tryFont(join(outside, 'ok.woff2')), /must be inside/);
  symlinkSync(join(outside, 'ok.woff2'), join(allowed, 'link.woff2'));
  await assert.rejects(tryFont(join(allowed, 'link.woff2')), /must be inside/);
  await assert.rejects(tryFont(join(allowed, '..', outside.split('/').pop()!, 'ok.woff2')), /must be inside/);
  // Inside the folder but not a font, or a damaged one.
  const cases: [string, Buffer, RegExp][] = [
    ['letters.ttf', Buffer.alloc(4000, 65), /not a TTF, OTF, WOFF or WOFF2/],
    ['short.woff2', (() => { const b = woff2(); b.writeUInt32BE(b.length + 1, 8); return b; })(), /header that does not match its size/],
    ['tiny.woff2', Buffer.from('wOF2'), /between 1 KB and 2 MB/],
    ['nohead.ttf', (() => { const b = Buffer.alloc(4000, 0); b.writeUInt32BE(0x00010000, 0); b.writeUInt16BE(1, 4); b.write('cmap', 12, 'latin1'); return b; })(), /table directory/],
    ['badmagic.ttf', (() => { const b = Buffer.alloc(4000, 0); b.writeUInt32BE(0x00010000, 0); b.writeUInt16BE(1, 4); b.write('head', 12, 'latin1'); b.writeUInt32BE(100, 20); b.writeUInt32BE(54, 24); return b; })(), /table directory/],
    ['pastend.ttf', (() => { const b = Buffer.alloc(4000, 0); b.writeUInt32BE(0x00010000, 0); b.writeUInt16BE(1, 4); b.write('head', 12, 'latin1'); b.writeUInt32BE(3990, 20); b.writeUInt32BE(54, 24); return b; })(), /table directory/],
  ];
  for (const [name, bytes, re] of cases) {
    writeFileSync(join(allowed, name), bytes);
    await assert.rejects(tryFont(join(allowed, name)), re, name);
  }
  await assert.rejects(tryFont(join(allowed, 'missing.ttf')), /cannot be read/);
  // A FIFO is refused at once. Without O_NONBLOCK, opening it would wait for a writer forever.
  const fifo = join(allowed, 'pipe.ttf');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await assert.rejects(tryFont(fifo), /not a regular file/);
  // A folder is refused too.
  mkdirSync(join(allowed, 'dir.ttf'));
  await assert.rejects(tryFont(join(allowed, 'dir.ttf')), /not a regular file/);
  // Nothing from these tests was written into the repo.
  assert.ok(!existsSync(join(REPO_ROOT, 'config', 'local', 'fonts')) || readdirSync(join(REPO_ROOT, 'config', 'local', 'fonts')).length === 0);
});

test('the branding file is read like a font: inside config/branding or config/local, a regular file, bounded', async () => {
  const dir = tempDir();
  const write = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  assert.throws(() => makeConfig({ brandingFile: write('ok.json', '{"tagline":"Hi."}') }), /must be inside config\/branding or config\/local/);
  symlinkSync(join(REPO_ROOT, 'config', 'branding', 'cheese-and-crackers.json'), join(dir, 'link.json'));
  // A link from outside to a file inside resolves to the inside file, which is allowed.
  assert.equal(makeConfig({ brandingFile: join(dir, 'link.json') }).branding.storeName, 'Cheese & Crackers');
  // A link that points the other way is refused.
  const target = write('target.json', '{}');
  assert.throws(() => makeConfig({ brandingFile: target }), /must be inside/);
  const fifo = join(dir, 'pipe.json');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.throws(() => makeConfig({ brandingFile: fifo }), /must be inside|Cannot read/);
  assert.throws(() => makeConfig({ brandingFile: join(REPO_ROOT, 'config', 'branding') }), /must be inside/);
  assert.throws(() => makeConfig({ brandingFile: join(REPO_ROOT, 'config', 'branding', 'missing.json') }), /Cannot read the branding file/);
});

test('a route under /static/ that is not public still gets every access check', async (t) => {
  const s = await makeApp({}, {
    extraRoutes: (app) => {
      app.get('/static/for-users', { config: { access: 'user' } }, async () => 'users only');
      app.post('/static/for-users', { config: { access: 'user' } }, async () => 'posted');
      app.get('/static/for-admins', { config: { access: 'admin' } }, async () => 'admins only');
      app.get('/static/no-access', { config: {} }, async () => 'oops');
      app.get('/legal/for-users', { config: { access: 'user' } }, async () => 'users only');
    },
  });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const mgr = (await login(s, 'mgr', MANAGER_PW)).cookie;
  const admin = (await login(s, 'bart', ADMIN_PW)).cookie;
  for (const url of ['/static/for-users', '/legal/for-users']) {
    const anon = await get(s, url);
    assert.equal(anon.statusCode, 303, url);
    assert.equal(anon.headers.location, '/login');
    assert.equal((await get(s, url, mgr)).body, 'users only', 'a signed in user gets it, so the session was read');
  }
  assert.equal((await get(s, '/static/for-admins')).statusCode, 303);
  assert.equal((await get(s, '/static/for-admins', mgr)).statusCode, 403);
  assert.equal((await get(s, '/static/for-admins', admin)).statusCode, 200);
  assert.equal((await get(s, '/static/no-access')).statusCode, 500, 'a route with no access level is refused');
  assert.equal((await get(s, '/static/no-access', admin)).statusCode, 500);
  // A post still needs the session's token and an allowed origin.
  const origin = { origin: ORIGIN, cookie: mgr, 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await s.app.inject({ method: 'POST', url: '/static/for-users', headers: origin, payload: 'a=b' })).statusCode, 403);
  assert.equal((await s.app.inject({ method: 'POST', url: '/static/for-users', headers: { ...origin, origin: 'http://evil.example' }, payload: 'a=b' })).statusCode, 403);
  assert.equal((await s.app.inject({ method: 'POST', url: '/static/for-users', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, payload: 'a=b' })).statusCode, 401);
});

test('branding that would break the page or be unreadable is refused at start', () => {
  const ok = (b: unknown): unknown => makeConfig({ branding: b as never });
  for (const bad of [
    { colors: { red: 'red' } },
    { colors: { ink: '#12345' } },
    { colors: { bg: '#f5f2eb; background: url(x)' } },
    { colors: { red: '#fafaf0' } }, // red text on cream: unreadable
    { colors: { yellow: '#222222' } }, // ink on yellow: unreadable
    { colors: { inkMid: '#8a8a80' } },
    { appName: '<script>' },
    { appName: '' },
    { appName: 'Zero​width' },
    { appName: 'Line break' },
    { appName: 'Bell\u0007' },
    { storeName: 'x'.repeat(61) },
    { tagline: '<b>' },
    { footerLine: 'a\nb' },
    { logoMark: '12345' },
    { logoMark: '<b>' },
    { logoMark: 1234 },
    { logoMark: ['C'] },
    { logoMark: { toString: () => 'C' } },
    { fonts: { body: { family: 'Bad"; } body { display: none' } } },
    { fonts: { display: { weights: '400 bold' } } },
  ]) {
    assert.throws(() => ok(bad), Error, JSON.stringify(bad));
  }
  // Store name, tagline and footer line may be empty. The app name may not.
  makeConfig({ branding: { storeName: '', tagline: '', footerLine: '' } });
  // Names with accents and ampersands are fine.
  makeConfig({ branding: { storeName: 'Café & Épicerie' } });
});

test('every text and background pair the stylesheet uses passes WCAG AA, in the default and the store palette', () => {
  const palettes = [defaultBranding().colors, makeConfig({ brandingFile: join(REPO_ROOT, 'config', 'branding', 'cheese-and-crackers.json') }).branding.colors];
  for (const colors of palettes) {
    for (const [label, fg, bg] of COLOR_PAIRS) assert.ok(contrastRatio(colors[fg], colors[bg]) >= 4.5, `${label} ${colors[fg]} on ${colors[bg]}`);
  }
  const labels = COLOR_PAIRS.map((p) => p[0]);
  for (const need of ['secondary text on yellow', 'disabled button text', 'bg on dark red', 'ink on dark yellow', 'yellow on ink', 'bg on red']) assert.ok(labels.includes(need), need);
  assert.ok(contrastRatio('#000000', '#ffffff') > 20.9);
  // Branding paths resolve against the repo root.
  assert.ok(makeBranding({}, (p) => join(REPO_ROOT, p)).fonts.display.normal.startsWith(REPO_ROOT));
});

test('error links keep a visible focus ring and a readable hover, and print drops the frame', () => {
  const css = readFileSync(new URL('../src/server/static/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.error :focus-visible \{ outline-color: var\(--bg\); \}/);
  assert.match(css, /\.error a:hover \{ color: var\(--bg\);/, 'cream on red, not yellow on red');
  assert.doesNotMatch(css, /\.error[^{]*:hover \{[^}]*var\(--yellow\)/);
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.mode-dry-run::after, \.mode-live::after \{ display: none; \}/);
  assert.match(print, /\.banner \{ position: static;/, 'the banner still prints');
});
