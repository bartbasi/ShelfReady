// Every page template in one place. Plain semantic HTML, no inline script or style.
// The look is the Deli Culture design system: see src/server/static/app.css. Colours, names and
// fonts come from the branding block of the server config (src/server/branding.ts), never from
// this file, so another store can rebrand.
//
// Pages work without JavaScript. There is none.

import type { SessionUser } from '../../auth/sessions.ts';
import type { User } from '../../auth/users.ts';
import type { SecretStatus } from '../../settings/store.ts';
import {
  exampleShelfCents,
  formatCents,
  ROUNDINGS,
  SECRET_LABELS,
  SECRET_NAMES,
  vendorLines,
  type PriceFormula,
  type SecretName,
  type SettingValues,
} from '../../settings/schema.ts';
import { currentLook, type Look } from '../look.ts';
import type { ScriptName } from '../static.ts';
import type { CertStatus, RenewalEntry } from '../cert-status.ts';
import { html, SafeHtml } from './html.ts';

/** Which item of the main menu is the current page. */
export type NavKey = 'home' | 'runs' | 'history' | 'settings' | 'users' | 'account' | 'about';

/** How loud the page is about what it does. A dry run writes nothing. A live run changes Square and the scales. */
export type PageMode = 'dry-run' | 'live';

export interface PageOpts {
  title: string;
  /** Branding and file versions. Left out, the page takes the look of the request it is rendered for. */
  look?: Look;
  user?: SessionUser | null;
  body: SafeHtml;
  /** Small red label above the title, like "01" or "Admin". */
  eyebrow?: string;
  /** Marks this page in the main menu. */
  nav?: NavKey;
  /**
   * Set 'dry-run' on every page that shows or runs a dry run. The page gets the DRY RUN banner,
   * a striped frame and a title that starts with DRY RUN, so it cannot be taken for a real run.
   * Do not add a second banner by hand. Set 'live' on pages where a click changes Square or the scales.
   */
  mode?: PageMode;
  /** Progressive scripts for this page, from the fixed list in static.ts. The page must work without them. */
  scripts?: readonly ScriptName[];
  /** Reload the page every so many seconds, for work in progress. No script needed. */
  refreshSeconds?: number;
}

export function csrfField(user: SessionUser): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${user.csrfToken}">`;
}

export function messages(error?: string, notice?: string): SafeHtml {
  return html`${error ? html`<p class="error" role="alert">${error}</p>` : ''}${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}`;
}

/** The loud banner for dry runs. layout() adds it for mode 'dry-run'. Use this only outside layout. */
export function dryRunBanner(detail = 'Nothing is sent to Square or the scales.'): SafeHtml {
  return html`<div class="banner banner-dry" role="status"><p class="banner-label">DRY RUN</p><p class="banner-text">${detail}</p></div>`;
}

/** The matching banner for pages where a click changes Square and the scales. */
export function liveBanner(detail = 'This changes Square and the scales.'): SafeHtml {
  return html`<div class="banner banner-live" role="status"><p class="banner-label">LIVE</p><p class="banner-text">${detail}</p></div>`;
}

/** A small tag for a list row or card that belongs to a dry run. */
export function dryRunTag(): SafeHtml {
  return html`<span class="tag tag-dry">DRY RUN</span>`;
}

/** A small tag for a list row or card that is a real run. */
export function liveTag(): SafeHtml {
  return html`<span class="tag tag-live">LIVE</span>`;
}

/** A numbered eyebrow, like "01". Hidden from screen readers, since it only decorates. */
export function eyebrow(text: string): SafeHtml {
  return html`<p class="eyebrow" aria-hidden="true">${text}</p>`;
}

/** Attribute names allowed through an attribute map. Values are always escaped. */
const ATTR_NAME = /^[a-z][a-z-]*$/;

function attrs(map: Record<string, string>): SafeHtml {
  return html`${Object.entries(map).map(([k, v]) => {
    if (!ATTR_NAME.test(k)) throw new Error(`Bad attribute name ${k}`);
    return html` ${new SafeHtml(k)}="${v}"`;
  })}`;
}

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', manager: 'Manager' };

function navLink(key: NavKey, current: NavKey | undefined, href: string, label: string): SafeHtml {
  return html`<li><a class="navlink" href="${href}"${key === current ? html` aria-current="page"` : ''}>${label}</a></li>`;
}

export function layout(o: PageOpts): string {
  const u = o.user;
  const look = o.look ?? currentLook();
  const b = look.branding;
  const v = (s: string): string => (s ? `?v=${s}` : '');
  const nav = u
    ? html`<nav class="mainnav" aria-label="Main">
  <ul>
    ${navLink('home', o.nav, '/', 'Home')}
    ${navLink('runs', o.nav, '/runs', 'Invoices')}
    ${navLink('history', o.nav, '/history', 'Purchase history')}
    ${u.role === 'admin' ? html`${navLink('settings', o.nav, '/settings', 'Settings')}${navLink('users', o.nav, '/users', 'Users')}` : ''}
    ${navLink('account', o.nav, '/account', 'Account')}
    ${navLink('about', o.nav, '/about', 'About')}
    <li><form method="post" action="/logout">${csrfField(u)}<button type="submit" class="navlink">Sign out</button></form></li>
  </ul>
</nav>`
    : html`<nav class="mainnav" aria-label="Main"><ul>${navLink('home', o.nav, '/login', 'Sign in')}${navLink('about', o.nav, '/about', 'About')}</ul></nav>`;
  const who = u
    ? html`<p class="who"><span class="sr-only">Signed in as </span><span class="who-name">${u.displayName || u.username}</span><span class="role role-${u.role === 'admin' ? 'admin' : 'manager'}">${ROLE_LABEL[u.role] ?? u.role}</span></p>`
    : '';
  const banner = o.mode === 'dry-run' ? dryRunBanner() : o.mode === 'live' ? liveBanner() : '';
  const title = `${o.mode === 'dry-run' ? 'DRY RUN: ' : o.mode === 'live' ? 'LIVE: ' : ''}${o.title} | ${b.appName}`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${b.colors.ink}">
${o.refreshSeconds ? html`<meta http-equiv="refresh" content="${String(Math.max(2, Math.floor(o.refreshSeconds)))}">` : ''}
<title>${title}</title>
<link rel="icon" href="/static/icon.svg${v(look.iconVersion)}" type="image/svg+xml">
<link rel="stylesheet" href="/static/theme.css${v(look.themeVersion)}">
<link rel="stylesheet" href="/static/app.css${v(look.cssVersion)}">
${(o.scripts ?? []).map((n) => html`<script src="/static/js/${n}.js${v(look.scriptVersions[n] ?? '')}" defer></script>
`)}</head>
<body${o.mode ? html` class="mode-${o.mode}"` : ''}>
<a class="skip" href="#main">Skip to the page</a>
<header class="topbar">
  <div class="topbar-brand">
    <a class="logo" href="/" aria-label="${b.appName}, home">${b.logoMark}</a>
    <a class="wordmark" href="/">${b.appName}</a>
    ${who}
  </div>
  ${nav}
</header>
<main id="main">
${banner}
<div class="page-head"><div class="wrap">
${o.eyebrow ? eyebrow(o.eyebrow) : ''}
<h1>${o.title}</h1>
</div></div>
<div class="wrap page-body">
${o.body}
</div>
</main>
<footer class="sitefoot"><div class="wrap">
  ${b.storeName ? html`<p class="foot-store">${b.storeName}</p>` : ''}
  ${b.tagline ? html`<p class="foot-tagline">${b.tagline}</p>` : ''}
  ${b.footerLine ? html`<p class="foot-legal">${b.footerLine}</p>` : ''}
  <p class="foot-legal"><a href="/about">About ${b.appName}, license and notice</a></p>
</div></footer>
</body>
</html>
`.value;
}

export function loginPage(o: { csrf: string; username?: string; error?: string; look?: Look }): string {
  const b = (o.look ?? currentLook()).branding;
  return layout({
    look: o.look,
    title: 'Sign in',
    eyebrow: b.storeName || undefined,
    nav: 'home',
    body: html`<div class="split">
<div class="split-main">
${messages(o.error)}
<form method="post" action="/login" class="stack">
  <input type="hidden" name="_csrf" value="${o.csrf}">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="64" value="${o.username ?? ''}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
  <label class="check"><input type="checkbox" name="remember" value="1"> Remember this device for 30 days</label>
  <button type="submit">Sign in</button>
</form>
</div>
<aside class="split-side" aria-label="About this app">
  ${b.tagline ? html`<p class="side-tagline">${b.tagline}</p>` : ''}
  <p>${b.appName} reads a supplier invoice, prices it, updates Square and the scales, and builds the shelf cards.</p>
</aside>
</div>`,
  });
}

function tile(href: string, index: string, name: string, text: string, extra = ''): SafeHtml {
  return html`<a class="tile${extra ? ` ${extra}` : ''}" href="${href}"><span class="eyebrow" aria-hidden="true">${index}</span><span class="tile-name">${name}</span><span class="tile-text">${text}</span></a>`;
}

export function homePage(user: SessionUser, alerts?: SafeHtml): string {
  const admin = user.role === 'admin';
  return layout({
    title: 'Home',
    user,
    nav: 'home',
    eyebrow: currentLook().branding.storeName || undefined,
    body: html`<p class="lead">Signed in as <strong>${user.displayName || user.username}</strong> (${user.role}).
${admin ? 'You can do everything a manager can, and also change settings, keys and users.' : 'You can upload, review, approve, run a dry run and resend to a scale.'}</p>
${alerts ?? ''}
<section aria-labelledby="inv-h">
  <h2 id="inv-h">Invoices</h2>
  <div class="tiles">
    ${tile('/runs/new', '01', 'Upload an invoice', 'Take photos of it or choose a PDF.', 'tile-primary')}
    ${tile('/runs', '02', 'Invoices so far', 'See what was uploaded and where each one stands.')}
    ${tile('/history', '03', 'Purchase history', 'Every invoice as a spreadsheet. Old invoices recorded here change nothing in Square, the scales or the cards.')}
  </div>
</section>
${admin
  ? html`<section aria-labelledby="admin-h">
  <h2 id="admin-h">Admin only</h2>
  <div class="tiles">
    ${tile('/settings', '04', 'Settings', 'Keys, Square, ScaleConnect and pricing.')}
    ${tile('/users', '05', 'Users', 'Add people, change roles, reset passwords.')}
  </div>
</section>`
  : ''}`,
  });
}

/**
 * The software notice. It comes from code, not from branding, because NOTICE (section 7 of the
 * license terms) requires these words on the About screen in every version of the app.
 */
export const SOFTWARE_NOTICE = 'ShelfReady. Designed and written by Bart Basi, with assistance from Claude. Copyright 2026 Cheese & Crackers, Inc.';

export function aboutPage(user: SessionUser | null): string {
  const b = currentLook().branding;
  return layout({
    title: 'About',
    user,
    nav: 'about',
    eyebrow: b.storeName || undefined,
    body: html`<p class="lead">ShelfReady reads a supplier invoice, prices it, updates Square and the scales, and builds the shelf cards.</p>
${b.footerLine ? html`<section aria-labelledby="store-h">
<h2 id="store-h">${b.storeName || 'This store'}</h2>
<p>${b.footerLine}</p>
</section>` : ''}
<section aria-labelledby="notice-h">
<h2 id="notice-h">Software notice</h2>
<p>${SOFTWARE_NOTICE}</p>
<p>ShelfReady is free software. You can redistribute it and change it under the terms of the GNU General Public License, version 3, with the additional terms in the NOTICE file.
It comes with no warranty.</p>
<ul>
<li><a href="/legal/LICENSE">The license: GNU General Public License, version 3 (LICENSE)</a></li>
<li><a href="/legal/NOTICE">The notice and additional terms (NOTICE)</a></li>
</ul>
</section>
<section aria-labelledby="fonts-h">
<h2 id="fonts-h">Fonts</h2>
<p>The page fonts are ${b.fonts.display.family} and ${b.fonts.body.family}. They are served from this app, not from another site.
The fonts that come with the app, Fraunces and Space Grotesk, are used under the SIL Open Font License, version 1.1.</p>
<ul>
<li><a href="/legal/OFL-Fraunces.txt">Fraunces license</a></li>
<li><a href="/legal/OFL-SpaceGrotesk.txt">Space Grotesk license</a></li>
</ul>
</section>`,
  });
}

export function errorPage(status: number, message: string, user: SessionUser | null = null): string {
  return layout({
    title: status === 404 ? 'Not found' : status === 403 ? 'No access' : 'Something went wrong',
    user,
    eyebrow: `Error ${status}`,
    body: html`<p class="lead">${message}</p><p><a class="button" href="/">Go home</a></p>`,
  });
}

export function accountPage(o: { user: SessionUser; minLength: number; error?: string; notice?: string }): string {
  return layout({
    title: 'Account',
    user: o.user,
    nav: 'account',
    eyebrow: o.user.username,
    body: html`${o.user.mustChangePassword ? html`<p class="notice" role="status">Please choose your own password before you go on.</p>` : ''}
${messages(o.error, o.notice)}
<div class="cols">
<section aria-labelledby="pw-h">
<h2 id="pw-h">Change password</h2>
<p class="hint">Your other phones and computers are signed out when you change it.</p>
<form method="post" action="/account/password" class="stack">
  ${csrfField(o.user)}
  <input type="hidden" name="username" autocomplete="username" value="${o.user.username}">
  <label for="current">Current password</label>
  <input id="current" name="current" type="password" autocomplete="current-password" required maxlength="256">
  <label for="new">New password (at least ${o.minLength} characters)</label>
  <input id="new" name="password" type="password" autocomplete="new-password" required minlength="${o.minLength}" maxlength="256">
  <label for="confirm">New password again</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="${o.minLength}" maxlength="256">
  <button type="submit">Change password</button>
</form>
</section>
<section aria-labelledby="dev-h">
<h2 id="dev-h">Devices</h2>
<p>Sign out on every phone and computer, including this one.</p>
<form method="post" action="/account/sign-out-everywhere">${csrfField(o.user)}<button type="submit" class="button-outline">Sign out everywhere</button></form>
</section>
</div>`,
  });
}

/** Shown on admin pages when the password was last typed more than the allowed minutes ago. */
export function reauthBox(user: SessionUser, next: string, minutes: number): SafeHtml {
  return html`<section class="card" aria-labelledby="reauth-h">
<h2 id="reauth-h">Confirm it is you</h2>
<p>Changes here need your password typed in the last ${minutes} minutes.</p>
<form method="post" action="/reauth" class="stack">
  ${csrfField(user)}
  <input type="hidden" name="next" value="${next}">
  <input type="hidden" name="username" autocomplete="username" value="${user.username}">
  <label for="reauth-password">Your password</label>
  <input id="reauth-password" name="password" type="password" autocomplete="current-password" required maxlength="256">
  <button type="submit">Confirm</button>
</form>
</section>`;
}

function secretField(name: SecretName, status: SecretStatus): SafeHtml {
  const state = status.damaged ? 'Damaged, please enter it again' : status.set ? (status.hint ? `Set, ends in ${status.hint}` : 'Set') : 'Not set';
  return html`<fieldset>
  <legend>${SECRET_LABELS[name]}</legend>
  <p class="hint" id="${name}-state">${state}. Leave blank to keep it.</p>
  <input id="${name}" name="secret_${name}" type="password" autocomplete="off" spellcheck="false" maxlength="300" aria-describedby="${name}-state" aria-label="New ${SECRET_LABELS[name]}">
  ${status.set ? html`<label class="check"><input type="checkbox" name="clear_${name}" value="1"> Remove it</label>` : ''}
</fieldset>`;
}

export interface SettingsForm {
  anthropicFirstPassModel: string;
  anthropicFallbackModel: string;
  invoiceCostCapUsd: string;
  cardCopyCapUsd: string;
  dailyLimitUsd: string;
  historySharePercent: string;
  bigChangePercent: string;
  squareEnvironment: string;
  squareLocationId: string;
  scaleConnectUrl: string;
  cardConfigPath: string;
  pricingAddBefore: string;
  pricingMultiplier: string;
  pricingAddAfter: string;
  pricingRounding: string;
  pricingVendors: string;
}

/** The form fields that show one setting. */
export function formFieldsFor(name: string): (keyof SettingsForm)[] {
  return name === 'pricing'
    ? ['pricingAddBefore', 'pricingMultiplier', 'pricingAddAfter', 'pricingRounding', 'pricingVendors']
    : [name as keyof SettingsForm];
}

/**
 * The form for saved values. Damaged settings are left blank (selects show "Choose"), so a blank
 * post means leave it as it is, and any value posted, the default included, repairs it.
 */
export function settingsFormFrom(v: SettingValues, damaged: readonly string[] = []): SettingsForm {
  const form = settingsFormFromValues(v);
  for (const name of damaged) for (const f of formFieldsFor(name)) form[f] = '';
  return form;
}

function settingsFormFromValues(v: SettingValues): SettingsForm {
  return {
    anthropicFirstPassModel: v.anthropicFirstPassModel,
    anthropicFallbackModel: v.anthropicFallbackModel,
    invoiceCostCapUsd: v.invoiceCostCapUsd,
    cardCopyCapUsd: v.cardCopyCapUsd,
    dailyLimitUsd: v.dailyLimitUsd,
    historySharePercent: v.historySharePercent,
    bigChangePercent: v.bigChangePercent,
    squareEnvironment: v.squareEnvironment,
    squareLocationId: v.squareLocationId,
    scaleConnectUrl: v.scaleConnectUrl,
    cardConfigPath: v.cardConfigPath,
    pricingAddBefore: v.pricing.default.addBefore,
    pricingMultiplier: v.pricing.default.multiplier,
    pricingAddAfter: v.pricing.default.addAfter,
    pricingRounding: v.pricing.default.rounding,
    pricingVendors: vendorLines(v.pricing.vendors),
  };
}

const EXAMPLE_COST = '10.00';

function example(f: PriceFormula): string {
  return `$${EXAMPLE_COST} cost gives ${formatCents(exampleShelfCents(f, EXAMPLE_COST))}`;
}

function roundingLabel(r: string): string {
  return r === 'up-to-99' ? 'Up to the next .99' : r;
}

/** How the server listens, from the server config. Shown read only: it is set on the PC itself. */
export interface NetworkView {
  tls: boolean;
  port: number;
  host: string;
  allowedHosts: string[];
  listenAddresses: string[];
  /** The listenAddresses taking connections now. */
  listening: string[];
  /** listenAddresses where another program holds the port: an alarm. */
  inUse: string[];
  hstsMaxAgeSeconds: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function duration(seconds: number): string {
  if (seconds === 0) return 'off';
  if (seconds % 86400 === 0) return seconds === 86400 ? '1 day' : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? '1 minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function renewalLine(e: RenewalEntry | undefined): string {
  if (!e) return 'Not yet.';
  return `${utcTime(e.at)}: ${e.ok ? 'worked' : 'did not work'}. ${e.message}`;
}

/** The certificate and how the server listens. Read only. Admins see it on the settings page. */
export function certificateSection(cert: CertStatus, net: NetworkView): SafeHtml {
  const listening = (a: string): string =>
    net.listening.includes(a) ? a : net.inUse.includes(a) ? `${a} (taken by another program)` : `${a} (not up yet; ShelfReady keeps trying)`;
  const warnings: string[] = [];
  // Another program on our address and port could be pretending to be ShelfReady to phones.
  for (const a of net.inUse) {
    warnings.push(`Another program is listening on ${a} port ${net.port}, so ShelfReady cannot. Phones on that network may reach that program instead. Stop it, as docs/INSTALL.md says.`);
  }
  if (!cert.problem && cert.privateStore) {
    // Made by hand once a year, never renewed by a job: only its end date matters.
    if (cert.expired) warnings.push('The private store certificate has run out. Phones will refuse ShelfReady until a new one is made and its store CA is installed on both phones (docs/INSTALL.md, Phase 1).');
    else if ((cert.daysLeft ?? 0) < 30) warnings.push(`The private store certificate ends on ${utcDay(cert.validTo ?? 0)}. Before then, make a new one and install its store CA on both phones (docs/INSTALL.md, Phase 1).`);
  } else if (!cert.problem) {
    if (cert.staging) warnings.push('This is a test certificate from the Let\'s Encrypt staging service. Phones will not trust it. Get the real one as docs/INSTALL.md says.');
    if (cert.expired) warnings.push('The certificate has run out. Phones will refuse ShelfReady until it is renewed.');
    else if (cert.due) warnings.push('The certificate is due for renewal. The daily check renews it; if this stays, see docs/INSTALL.md.');
    if (cert.checkStale) warnings.push('The daily renewal check has not run in the last two days. Check the crontab, as docs/INSTALL.md says.');
    if (cert.record.lastRenewal && !cert.record.lastRenewal.ok) warnings.push(`The last renewal did not work. ${cert.record.lastRenewal.message}`);
  }
  if (cert.recordProblem) warnings.push(cert.recordProblem);
  return html`<section aria-labelledby="cert-h">
  ${eyebrow('06')}
  <h2 id="cert-h">Certificate and network</h2>
  <p class="hint">Set up on the PC itself, not here: see docs/INSTALL.md.</p>
  ${net.tls
    ? html`<dl class="facts">
    <dt>Address</dt><dd>${net.allowedHosts.length ? net.allowedHosts.map((h) => (net.port === 443 ? `https://${h}` : `https://${h}:${net.port}`)).join(', ') : `https://localhost:${net.port} (this PC only)`}</dd>
    <dt>Listening on</dt><dd>${[net.host, ...net.listenAddresses.map(listening)].join(', ')}</dd>
    <dt>HTTPS only (HSTS)</dt><dd>${duration(net.hstsMaxAgeSeconds)}</dd>
  </dl>`
    : html`<p class="notice">HTTPS is off. ShelfReady answers only on this PC.</p>`}
  <h3>Certificate</h3>
  ${cert.problem
    ? html`<p class="${net.tls ? 'error' : 'hint'}">${cert.problem}</p>`
    : cert.privateStore
      ? html`<p>This is the private store certificate, made on this PC. Phones trust it once the store CA is installed on them. It is not renewed on its own: before it ends, a new one is made and installed on the phones.</p>
  <dl class="facts">
    <dt>Names</dt><dd>${cert.names.join(', ') || 'none'}</dd>
    <dt>Issued by</dt><dd>${cert.issuer}</dd>
    <dt>Valid until</dt><dd>${cert.validTo !== undefined ? `${utcTime(cert.validTo)} (${cert.expired ? 'ended' : `${cert.daysLeft} days left`})` : ''}</dd>
  </dl>`
      : html`<dl class="facts">
    <dt>Names</dt><dd>${cert.names.join(', ') || 'none'}</dd>
    <dt>Issued by</dt><dd>${cert.issuer}${cert.staging ? ' (test only)' : ''}</dd>
    <dt>Valid until</dt><dd>${cert.validTo !== undefined ? `${utcTime(cert.validTo)} (${cert.expired ? 'ended' : `${cert.daysLeft} days left`})` : ''}</dd>
    <dt>Next renewal</dt><dd>${cert.due ? 'Due now' : cert.renewAt !== undefined ? utcDay(cert.renewAt) : ''}</dd>
    <dt>Last renewal</dt><dd>${renewalLine(cert.record.lastRenewal)}</dd>
    <dt>Last daily check</dt><dd>${renewalLine(cert.record.lastCheck)}</dd>
    <dt>Last renewal test</dt><dd>${renewalLine(cert.record.lastDryRun)}</dd>
  </dl>`}
  ${warnings.map((w) => html`<p class="error" role="alert">${w}</p>`)}
</section>`;
}

/** The Square in use, said plainly at the top of the Square section. */
function squareInUse(u: SettingsInUse | undefined): SafeHtml | string {
  if (!u) return '';
  const env = u.squareLive
    ? html`<p class="callout callout-stop" role="status"><span class="tag tag-live">LIVE</span> In use now: ${u.squareLabel}. Sending an invoice changes the store register.</p>`
    : html`<p class="callout" role="status"><span class="tag tag-mute">TEST</span> In use now: ${u.squareLabel}. Nothing reaches the store register.</p>`;
  const token = !u.squareTokenFor
    ? html`<p class="hint">No Square access token is saved.</p>`
    : u.squareTokenFor === u.squareLabel
      ? html`<p class="hint">The saved Square access token was entered for ${u.squareTokenFor}.</p>`
      : html`<p class="error">The saved Square access token was entered for ${u.squareTokenFor}, not ${u.squareLabel}, so ShelfReady does not send it. Enter the token for ${u.squareLabel}.</p>`;
  return html`${env}${token}`;
}

/** The scales in use, from the server config. */
function scalesInUse(u: SettingsInUse | undefined): SafeHtml | string {
  if (!u) return '';
  return u.scalesLive
    ? html`<p class="callout callout-stop" role="status"><span class="tag tag-live">LIVE</span> Sends go to the store scales: ${u.scales.join(', ') || 'none'}, through ${u.liveScaleConnectUrl}. The address below must be exactly that.</p>`
    : html`<p class="callout" role="status"><span class="tag tag-mute">TEST</span> Sends go only to the dev ScaleConnect harness on this PC, never the store scales.</p>`;
}

type SettingsInUse = NonNullable<Parameters<typeof settingsPage>[0]['inUse']>;

export function settingsPage(o: {
  user: SessionUser;
  form: SettingsForm;
  /** What is saved now, for the worked examples. */
  saved: SettingValues;
  secrets: Record<SecretName, SecretStatus>;
  damaged: string[];
  productionLocked: boolean;
  allowSquareProduction: boolean;
  /** What ShelfReady uses now, from the setting and the server config together. */
  inUse?: { squareLive: boolean; squareLabel: string; squareTokenFor?: string; scalesLive: boolean; scales: string[]; liveScaleConnectUrl: string };
  needsReauth: boolean;
  reauthMinutes: number;
  error?: string;
  notice?: string;
  /** The installed certificate and how the server listens, shown read only. */
  certificate?: CertStatus;
  network?: NetworkView;
}): string {
  const f = o.form;
  const text = (id: keyof SettingsForm, label: string, extra: Record<string, string> = {}): SafeHtml =>
    html`<label for="${id}">${label}</label><input id="${id}" name="${id}" value="${f[id]}" spellcheck="false" maxlength="500"${attrs(extra)}>`;
  const damaged = [...o.damaged, ...SECRET_NAMES.filter((n) => o.secrets[n].damaged).map((n) => SECRET_LABELS[n])];
  const pricingDamaged = o.damaged.includes('pricing');
  const vendors = o.saved.pricing.vendors;
  // While re-auth is needed the form is not shown, so nothing typed into it can be lost.
  const settingsForm = html`<form method="post" action="/settings" class="stack" autocomplete="off">
${csrfField(o.user)}
<section aria-labelledby="claude-h">
  ${eyebrow('01')}
  <h2 id="claude-h">Claude</h2>
  ${secretField('anthropicApiKey', o.secrets.anthropicApiKey)}
  ${text('anthropicFirstPassModel', 'First-pass model')}
  ${text('anthropicFallbackModel', 'Fallback model')}
  ${text('invoiceCostCapUsd', 'Reading cost cap per invoice, US dollars', { inputmode: 'decimal' })}
  <p class="hint">The most reading one invoice may cost. Past it, an admin approves first.</p>
  ${text('cardCopyCapUsd', 'Card copy cap per invoice, US dollars', { inputmode: 'decimal' })}
  <p class="hint">The most new card copy for one invoice may cost, apart from the reading. Past it, an admin approves all the cards still waiting at once.</p>
  ${text('dailyLimitUsd', 'Daily limit, US dollars', { inputmode: 'decimal' })}
  <p class="hint">The most readings and card copy together may cost in any 24 hours. Past it, an admin approves. Zero asks an admin every time.</p>
  ${text('historySharePercent', 'Share of the daily limit for old invoices, percent', { inputmode: 'numeric' })}
  <p class="hint">From 10 to 100. Old invoices recorded for the purchase history use at most this part of the daily limit, so they never block new invoices. Past it, they wait.</p>
</section>
<section aria-labelledby="square-h">
  ${eyebrow('02')}
  <h2 id="square-h">Square</h2>
  ${squareInUse(o.inUse)}
  <label for="squareEnvironment">Environment</label>
  <select id="squareEnvironment" name="squareEnvironment">
    ${f.squareEnvironment === '' ? html`<option value="" selected>Choose</option>` : ''}
    <option value="sandbox"${f.squareEnvironment === 'sandbox' ? html` selected` : ''}>Sandbox (test)</option>
    <option value="production"${f.squareEnvironment === 'production' ? html` selected` : ''}${o.allowSquareProduction ? '' : html` disabled`}>Production (live store)</option>
  </select>
  ${o.allowSquareProduction ? '' : html`<p class="hint">Production is locked until live Square is approved.</p>`}
  ${o.productionLocked ? html`<p class="error">Production is saved, but this install locks it, so sandbox is used.</p>` : ''}
  ${secretField('squareAccessToken', o.secrets.squareAccessToken)}
  <p class="hint">A token belongs to one environment. Changing the environment removes the token unless you enter the new one in the same save.</p>
  ${text('squareLocationId', 'Location id')}
</section>
<section aria-labelledby="sc-h">
  ${eyebrow('03')}
  <h2 id="sc-h">ScaleConnect</h2>
  ${scalesInUse(o.inUse)}
  ${text('scaleConnectUrl', 'ScaleConnect address', { inputmode: 'url' })}
  <p class="hint">Plain http only to this PC or the store network. Changing the address removes the token unless you enter it again in the same save.</p>
  ${secretField('scaleConnectToken', o.secrets.scaleConnectToken)}
  <p class="hint">The scale list comes from ScaleConnect. Add or remove scales in ScaleConnect's own config.</p>
</section>
<section aria-labelledby="pricing-h">
  ${eyebrow('04')}
  <h2 id="pricing-h">Pricing</h2>
  <p class="hint">Shelf price = (cost + add before) x multiplier + add after, then rounded.</p>
  ${text('pricingAddBefore', 'Add before multiplying', { inputmode: 'decimal' })}
  ${text('pricingMultiplier', 'Multiplier', { inputmode: 'decimal' })}
  ${text('pricingAddAfter', 'Add after multiplying', { inputmode: 'decimal' })}
  <label for="pricingRounding">Rounding</label>
  <select id="pricingRounding" name="pricingRounding">
    ${f.pricingRounding === '' ? html`<option value="" selected>Choose</option>` : ''}
    ${ROUNDINGS.map((r) => html`<option value="${r}"${f.pricingRounding === r ? html` selected` : ''}>${roundingLabel(r)}</option>`)}
  </select>
  ${pricingDamaged ? html`<p class="error">The saved pricing is damaged. Enter the formula and any vendor formulas again, then save.</p>` : html`<p class="hint">Saved formula: ${example(o.saved.pricing.default)}.</p>`}
  <h3>Big price changes</h3>
  ${text('bigChangePercent', 'A price moving more than this percent needs its own tick', { inputmode: 'numeric' })}
  <p class="hint">From 5 to 50. It applies up or down, against today's Square price. The scales ask again above 50 percent, so a higher limit is not allowed.</p>
  <h3>Vendor formulas</h3>
  ${pricingDamaged ? '' : vendors.length
    ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Saved vendor formulas"><table>
    <caption>Saved vendor formulas</caption>
    <thead><tr><th scope="col">Vendor</th><th scope="col">Add before</th><th scope="col">Multiplier</th><th scope="col">Add after</th><th scope="col">Rounding</th><th scope="col">Example</th></tr></thead>
    <tbody>${vendors.map(
      (v) =>
        html`<tr><td>${v.vendor}</td><td>${v.formula.addBefore}</td><td>${v.formula.multiplier}</td><td>${v.formula.addAfter}</td><td>${roundingLabel(v.formula.rounding)}</td><td>${example(v.formula)}</td></tr>`,
    )}</tbody>
  </table></div>`
    : html`<p class="hint">No vendor formulas yet. Every vendor uses the formula above.</p>`}
  <label for="pricingVendors">Edit vendor formulas, one per line: Vendor | add before | multiplier | add after | rounding (optional)</label>
  <p class="hint" id="pricingVendors-help">For example, a vendor priced at (cost + 2.25) x 2: Example Cheese Co | 2.25 | 2 | 0.00 | up-to-99</p>
  <textarea id="pricingVendors" name="pricingVendors" rows="4" spellcheck="false" maxlength="20000" aria-describedby="pricingVendors-help">${f.pricingVendors}</textarea>
</section>
<section aria-labelledby="cards-h">
  ${eyebrow('05')}
  <h2 id="cards-h">Cards</h2>
  ${text('cardConfigPath', 'Card config file')}
</section>
<section aria-labelledby="mc-h">
  ${eyebrow('06')}
  <h2 id="mc-h">Mailchimp</h2>
  ${secretField('mailchimpApiKey', o.secrets.mailchimpApiKey)}
  <p class="hint">Used only for the fish email: ShelfReady changes fish prices, the name and the date line, and schedules it. It never sends right away, deletes a campaign or touches the list.</p>
</section>
<div class="action-bar"><button type="submit">Save settings</button></div>
</form>`;
  return layout({
    title: 'Settings',
    user: o.user,
    nav: 'settings',
    eyebrow: 'Admin',
    body: html`${messages(o.error, o.notice)}
${damaged.length ? html`<p class="error" role="alert">Some saved settings are damaged and cannot be read: ${damaged.join(', ')}. Please enter them again and save.</p>` : ''}
${o.needsReauth ? reauthBox(o.user, '/settings', o.reauthMinutes) : ''}
${o.needsReauth ? html`<p class="hint">Confirm your password above to see and change the settings.</p>` : settingsForm}
${o.certificate && o.network ? certificateSection(o.certificate, o.network) : ''}`,
  });
}

export function usersPage(o: {
  user: SessionUser;
  users: User[];
  minLength: number;
  needsReauth: boolean;
  reauthMinutes: number;
  error?: string;
  notice?: string;
}): string {
  const rows = o.users.map((u) => {
    const self = u.id === o.user.userId;
    return html`<li class="card">
  <h3>${u.username}${u.displayName ? html` <small>${u.displayName}</small>` : ''}</h3>
  <p><span class="role role-${u.role === 'admin' ? 'admin' : 'manager'}">${u.role}</span>${u.disabled ? html` <span class="tag">disabled</span>` : ''}${u.mustChangePassword ? html` <span class="tag">must change password</span>` : ''}${self ? html` <span class="tag">you</span>` : ''}</p>
${o.needsReauth ? '' : html`  <form method="post" action="/users/${u.id}/role" class="inline">${csrfField(o.user)}
    <label for="role-${u.id}">Role</label>
    <select id="role-${u.id}" name="role">
      <option value="manager"${u.role === 'manager' ? html` selected` : ''}>Manager</option>
      <option value="admin"${u.role === 'admin' ? html` selected` : ''}>Admin</option>
    </select>
    <button type="submit">Change role</button>
  </form>
  ${self ? html`<p><a href="/account">Change your own password on the Account page.</a></p>` : html`<form method="post" action="/users/${u.id}/password" class="inline">${csrfField(o.user)}
    <label for="pw-${u.id}">New password</label>
    <input id="pw-${u.id}" name="password" type="password" autocomplete="new-password" required minlength="${o.minLength}" maxlength="256">
    <button type="submit">Reset password</button>
  </form>`}
  <form method="post" action="/users/${u.id}/sign-out-everywhere" class="inline">${csrfField(o.user)}<button type="submit" class="button-outline">Sign out everywhere</button></form>
  ${self ? '' : html`<form method="post" action="/users/${u.id}/${u.disabled ? 'enable' : 'disable'}" class="inline">${csrfField(o.user)}<button type="submit" class="${u.disabled ? 'button-accent' : 'button-red'}">${u.disabled ? 'Enable' : 'Disable'}</button></form>`}`}
</li>`;
  });
  return layout({
    title: 'Users',
    user: o.user,
    nav: 'users',
    eyebrow: 'Admin',
    body: html`${messages(o.error, o.notice)}
${o.needsReauth ? reauthBox(o.user, '/users', o.reauthMinutes) : ''}
<p class="hint">Users are disabled, never deleted, so the log always shows who did what.</p>
<ul class="cards">${rows}</ul>
${o.needsReauth ? '' : html`<section aria-labelledby="add-h">
<h2 id="add-h">Add a user</h2>
<form method="post" action="/users" class="stack" autocomplete="off">
  ${csrfField(o.user)}
  <label for="new-username">Username</label>
  <input id="new-username" name="username" required maxlength="32" autocapitalize="none" spellcheck="false">
  <label for="new-display">Name (optional)</label>
  <input id="new-display" name="displayName" maxlength="64">
  <label for="new-role">Role</label>
  <select id="new-role" name="role"><option value="manager" selected>Manager</option><option value="admin">Admin</option></select>
  <label for="new-password">Starting password (at least ${o.minLength} characters). They choose their own at first sign in.</label>
  <input id="new-password" name="password" type="password" autocomplete="new-password" required minlength="${o.minLength}" maxlength="256">
  <button type="submit">Add user</button>
</form>
</section>`}`,
  });
}
