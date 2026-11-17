// The Fastify app. buildApp(config) returns a ready app; tests drive it with app.inject.
//
// Every route declares who may use it in config.access: 'public', 'user' (manager or admin)
// or 'admin'. A route without it is refused, so a new route cannot be left open by mistake.
// Access is checked in onRequest, before the body is read. The per-session CSRF token and the
// recent-password check need the body, so they run in preHandler.

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Socket } from 'node:net';
import type { Server as TlsServer } from 'node:tls';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { originAllowed, tokensEqual } from '../auth/csrf.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  lookupSession,
  markReauth,
  purgeExpiredSessions,
  sessionPolicy,
  type SessionUser,
} from '../auth/sessions.ts';
import {
  attemptSucceeded,
  beginAttempt,
  createHashLimiter,
  pruneThrottle,
  recordLoginEvent,
  summarizeLoginEvents,
  userKeyerFor,
  type UserKeyer,
} from '../auth/throttle.ts';
import { createUser, findUserByUsername, getUser, isRole, listUsers, setDisabled, setPassword, setRole, UserError } from '../auth/users.ts';
import { appendAudit, type AuditActor } from '../db/audit.ts';
import { openDatabase, type Db } from '../db/db.ts';
import { loadOrCreateMasterKey } from '../settings/crypto.ts';
import { parseVendorLines, SECRET_NAMES, SettingError, type SecretName, type SettingValues } from '../settings/schema.ts';
import { createSettings, type SecretStatus, type Settings, type SettingsChange } from '../settings/store.ts';
import { cookiesSecure, REPO_ROOT, type ServerConfig } from './config.ts';
import {
  aboutPage,
  accountPage,
  errorPage,
  homePage,
  layout,
  loginPage,
  reauthBox,
  formFieldsFor,
  settingsFormFrom,
  settingsPage,
  usersPage,
  type SettingsForm,
} from './views/pages.ts';
import { html } from './views/html.ts';
import { registerStatic } from './static.ts';
import { runWithLook, type Look } from './look.ts';
import { apiKeyProblem, createAnthropicModelClient, createInvoiceAnthropicClient, type InvoiceModelClient } from '../invoice/extract.ts';
import { DEFAULT_INVOICE_SETTINGS, type InvoiceReadingSettings } from '../invoice/settings.ts';
import { createCatalogCache } from '../runs/catalog-cache.ts';
import type { CardCopyStage } from '../runs/card-copy.ts';
import { createRunner, type Runner } from '../runs/runner.ts';
import { RunError } from '../runs/store.ts';
import { catalogLabelFor, fileCatalogSource, squareCatalogSource, type CatalogSource } from '../square/catalog-source.ts';
import { catalogSourceLabel, effectiveEnvironment, envForSource, mixedEnvironmentProblem, sourceForEnv, type SquareEnv } from '../square/origins.ts';
import { createSquareReader, type SquareWriter } from '../square/client.ts';
import { registerRunRoutes } from './run-routes.ts';
import { registerSendRoutes } from './send-routes.ts';
import { createSendJobs } from '../runs/send-jobs.ts';
import type { SendDeps } from '../runs/square-send.ts';
import { createSquareWriteApi, type SquareWriteApi } from '../square/writer.ts';
import { connectScaleConnect, scalePreflightProblem, type ScaleApi } from '../scaleconnect/connection.ts';
import { createSheetChecker, renderSheetCheck, type SheetCheckFn, type SheetChecker } from '../runs/sheet-check.ts';
import type { SheetDeps } from '../runs/card-sheets.ts';
import { loadCardConfig } from '../cards/config.ts';
import type { CardConfig } from '../cards/types.ts';
import { createCertReloader, filesSignature, loadTlsMaterial, secureContextOptions, tlsServerOptions, type CertReloader, type ReloadResult, type TlsMaterial } from './tls.ts';
import { hostAllowed, hostName, isDnsName } from './network.ts';
import { readCertStatus } from './cert-status.ts';
import { ExtraListeners } from './listen.ts';
import { createMailchimpService, type MailchimpService } from '../mailchimp/service.ts';
import type { MailchimpConfig } from '../mailchimp/config.ts';
import { registerFromCatalog, type RegisterBook } from '../mailchimp/register.ts';
import { clearAlert, dismissHeld, oldHeld, openAlerts } from '../mailchimp/store.ts';
import { mailchimpAlerts, mailchimpOldHeld } from './views/mailchimp-pages.ts';
import { createHistoryWorker, readingSettings, type HistoryWorker } from '../history/worker.ts';
import { HistoryError } from '../history/store.ts';
import { backfillRuns } from '../history/runs.ts';
import { registerHistoryRoutes } from './history-routes.ts';
import { createUploadSlots, type UploadSlots } from './upload-slots.ts';

export type Access = 'public' | 'user' | 'admin';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    /** Reachable while the user still has to change an admin-set password. */
    allowWhenMustChange?: boolean;
    /** An admin post that does not need a recent password. Only the re-auth form itself. */
    reauthExempt?: boolean;
    /** Needs the password typed within reauthMinutes, for any role (sending a run to Square and the scales). */
    recentPassword?: boolean;
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    shelf: {
      db: Db;
      settings: Settings;
      config: ServerConfig;
      routes: RouteInfo[];
      userKey: UserKeyer;
      housekeeping: () => void;
      runner: Runner;
      catalogSource: CatalogSource;
      sheetChecker: SheetChecker;
      /** The fish email worker and its config (src/mailchimp/service.ts). */
      mailchimp: MailchimpService;
      /** Reads old invoices for the purchase history (src/history/worker.ts). Record only. */
      history: HistoryWorker;
      /** Upload slots shared by the invoice run and old invoice uploads. */
      uploadSlots: UploadSlots;
      /** The store network and tailnet listeners (src/server/listen.ts). */
      listeners: ExtraListeners;
      /** Looks for a renewed certificate now and loads it. 'off' without TLS. */
      tlsReload: () => ReloadResult | 'off';
    };
  }
}

export interface RouteInfo {
  method: string;
  url: string;
  access: Access | undefined;
}

export interface AppDeps {
  /** Extra folders custom font files may come from, beyond the app's fonts folder and config/local/fonts. Tests pass a temp folder. */
  extraFontDirs?: readonly string[];
  /** Adds routes before the server is ready. Tests use it to put a route in a place that must be refused. */
  extraRoutes?: (app: FastifyInstance) => void;
  /** Clock in milliseconds. Tests move it forward to check expiry. */
  now?: () => number;
  /** Where log lines go. Tests capture them to check nothing secret is logged. */
  logStream?: { write(line: string): void };
  /** The model client for invoice reading. Tests pass a fake. Default: the Claude API with the key in settings. */
  modelClient?: InvoiceModelClient;
  /** The catalog source. Tests pass a fake. Default: the dev catalog file if the config names one, else Square. */
  catalogSource?: CatalogSource;
  /** fetch for the Square read client. Tests pass a fake. */
  squareFetch?: typeof fetch;
  /** Step 7's Square writer. The dry run is handed it only so tests can prove it is never called. */
  squareWriter?: SquareWriter;
  /** The Square write client for sending runs, whatever the environment. Tests pass a fake. */
  squareWriteApi?: SquareWriteApi;
  /** A connected ScaleConnect client for sending runs. Tests pass a fake or the dev harness. */
  scaleApi?: () => Promise<ScaleApi>;
  /** Tests: the answer of the check made before Square is written. Default: scalePreflightProblem. */
  scalePreflight?: () => string | null;
  /** The store's Square location for sending. Default: the setting. Tests pass the invented catalog's. */
  squareLocationId?: () => string;
  /** Card copy, once step 5 lands. */
  cardCopy?: CardCopyStage;
  /** Extra invoice reading settings, for tests. */
  invoiceSettings?: Partial<InvoiceReadingSettings>;
  /** Run queued jobs on their own. Default true. Tests turn it off and call runner.drain(). */
  startRunner?: boolean;
  /** The card sheet check. Default: LibreOffice and poppler (src/runs/sheet-check.ts). Tests pass a fake. */
  cardSheetCheck?: SheetCheckFn;
  /** The store card template. Default: config/cards/cheese-and-crackers.json. */
  cardConfig?: CardConfig;
  /** The fish email config. Default: config/mailchimp/cheese-and-crackers.json. */
  mailchimpConfig?: MailchimpConfig;
  /** Tests: the local Mailchimp ids file, instead of config/local/mailchimp.json. Used only without mailchimpConfig. */
  mailchimpLocalConfig?: string;
  /** Tests: a fake fetch for Mailchimp, or a fake Mailchimp on 127.0.0.1. Never from settings. */
  mailchimpFetch?: typeof fetch;
  mailchimpTestOrigin?: string;
  /** Tests: register prices for the fish email drift check. */
  mailchimpRegister?: () => Promise<RegisterBook | null>;
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
    'headers.authorization',
    'headers.cookie',
    'body',
    'req.body',
    // A malformed request's raw bytes, which can hold cookies.
    'err.rawPacket',
    'rawPacket',
    '*.rawPacket',
    'password',
    '*.password',
    'token',
    '*.token',
    'secret',
    '*.secret',
    'secrets',
    '*.secrets',
    'apiKey',
    '*.apiKey',
    'value',
    '*.value',
    'values',
    '*.values',
  ],
  censor: '[redacted]',
};

const NOTICES: Record<string, string> = {
  saved: 'Settings saved.',
  nochange: 'Nothing changed.',
  created: 'User added.',
  updated: 'User updated.',
  signedout: 'That user is signed out everywhere.',
  password: 'Password changed. Your other devices are signed out.',
  confirmed: 'Thanks. You can make changes for the next few minutes.',
};

const LOGIN_FAILED = 'Sign in did not work. Check your username and password and try again. After several tries, sign in pauses for a few minutes.';
const BUSY = 'ShelfReady is busy. Wait a moment and try again.';

/** Plain words for the Send page: where a send goes now. */
export function sendWhere(env: SquareEnv, config: Pick<ServerConfig, 'allowLiveScaleConnect' | 'writeScales' | 'scaleNames'>): string {
  const scales = config.writeScales.filter((n) => config.scaleNames.includes(n));
  const square = env === 'production' ? 'Square (live), the store register' : 'the Square sandbox (test)';
  const toScales = config.allowLiveScaleConnect ? `the store scales: ${scales.join(', ') || 'none'}` : 'the dev ScaleConnect harness on this PC only';
  const nothing =
    env === 'production' ? '' : config.allowLiveScaleConnect ? ' Nothing goes to live Square.' : ' Nothing goes to live Square or the store scales.';
  return `Sends to ${square}, then to ${toScales}.${nothing}`;
}

const REAUTH_NEXT = ['/settings', '/users', '/'] as const;
/** After a re-auth, back to a fixed page, to one invoice run, or to one old invoice. Never a free URL. */
function reauthNext(raw: string): string {
  if ((REAUTH_NEXT as readonly string[]).includes(raw)) return raw;
  if (/^\/runs\/[1-9][0-9]{0,9}(\/send)?$/.test(raw)) return raw;
  if (/^\/history\/[1-9][0-9]{0,9}$/.test(raw)) return raw;
  return '/settings';
}

class BadForm extends Error {}

function field(req: FastifyRequest, name: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const v = body?.[name];
  if (v === undefined) return '';
  if (typeof v !== 'string') throw new BadForm(name);
  return v;
}

function notice(req: FastifyRequest): string | undefined {
  const q = req.query as Record<string, unknown> | undefined;
  const code = typeof q?.notice === 'string' ? q.notice : '';
  return Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined;
}

function idParam(req: FastifyRequest): number {
  const raw = (req.params as { id?: string }).id ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new BadForm('id');
  return Number(raw);
}

const isRead = (req: FastifyRequest): boolean => req.method === 'GET' || req.method === 'HEAD';

const FORM_TIMER = Symbol('formTimer');
type TimedRequest = FastifyRequest & { [FORM_TIMER]?: NodeJS.Timeout };
const COUNTED = Symbol('counted');
type CountedRequest = FastifyRequest & { [COUNTED]?: boolean };

export async function buildApp(config: ServerConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  // The certificate and key are checked before anything else opens, so a bad file stops the start
  // with a plain message and nothing to clean up.
  const tlsMaterial: TlsMaterial | null = config.tls.enabled ? loadTlsMaterial(config.tls, config.allowedHosts, [REPO_ROOT, dirname(config.dbPath)]) : null;
  const db = openDatabase(config.dbPath);
  let mk;
  try {
    // A missing key may be created only while no encrypted settings exist.
    const rows = (db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n;
    mk = loadOrCreateMasterKey(config.masterKeyPath, [REPO_ROOT, dirname(config.dbPath)], { allowCreate: rows === 0 });
  } catch (err) {
    db.close();
    throw err;
  }
  const settings = createSettings(db, mk, { allowSquareProduction: config.allowSquareProduction, now });
  // Throttle rows are keyed by an HMAC of the name, never the typed text.
  const userKey = userKeyerFor(mk);
  const policy = sessionPolicy(config);
  const reauthMs = config.reauthMinutes * 60 * 1000;
  const secure = cookiesSecure(config);
  const SESSION_COOKIE = secure ? '__Host-sr_session' : 'sr_session';
  const LOGIN_COOKIE = secure ? '__Host-sr_login' : 'sr_login';
  // Unknown or disabled users are checked against this, so they take as long as a wrong password.
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'), config.scrypt);
  const limiter = createHashLimiter(config.maxConcurrentHashes);
  const pwOpts = { scrypt: config.scrypt, minLength: config.passwordMinLength };

  let appLog: FastifyInstance['log'] | undefined;
  // Node's own limits on every connection: the request head must arrive within headersTimeout and
  // fit in maxHeaderSize, and an HTTP/1.1 request without a Host header is refused. Node checks the
  // timeouts every quarter of headersTimeout.
  const headersMs = Math.round(config.headersTimeoutSeconds * 1000);
  const httpLimits = {
    maxHeaderSize: config.maxHeaderBytes,
    headersTimeout: headersMs,
    connectionsCheckingInterval: Math.max(100, Math.min(30_000, Math.round(headersMs / 4))),
    requireHostHeader: true,
    noDelay: true,
  };
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: REDACT,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      serializers: {
        // Only method, path and address. No headers, no query string, no body.
        req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
      },
    },
    // A malformed request never reaches a route. Answer 400 and log only the error code,
    // never the raw bytes, which can hold a cookie.
    clientErrorHandler: (err: NodeJS.ErrnoException, socket: Socket) => {
      appLog?.info({ code: err.code ?? 'unknown' }, 'client error');
      // A failed or stalled TLS handshake has no HTTP to answer in: a reply written there would
      // wait forever for the handshake, holding the socket open. Close it at once.
      const tlsFailure = typeof err.code === 'string' && /^ERR_(SSL|TLS)_/.test(err.code);
      if (!tlsFailure && socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        // end() waits to send the reply. Never let a socket linger if it cannot.
        setTimeout(() => socket.destroy(), 1000).unref();
      } else {
        socket.destroy();
      }
    },
    bodyLimit: config.bodyLimit,
    trustProxy: config.trustProxy,
    // A slow or stalled client cannot hold a connection or an upload slot for long.
    requestTimeout: Math.round(config.requestTimeoutSeconds * 1000),
    connectionTimeout: Math.round(config.connectionTimeoutSeconds * 1000),
    keepAliveTimeout: Math.round(config.keepAliveTimeoutSeconds * 1000),
    maxRequestsPerSocket: 1000,
    ...(tlsMaterial ? { https: { ...httpLimits, ...tlsServerOptions(tlsMaterial, Math.round(config.tlsHandshakeTimeoutSeconds * 1000)) } } : { http: httpLimits }),
  } as Parameters<typeof Fastify>[0]) as unknown as FastifyInstance;
  appLog = app.log;
  app.server.maxConnections = config.maxConnections;
  const listeners = new ExtraListeners();
  let inFlight = 0;
  // A renewed certificate is picked up without a restart. A bad pair is not used.
  let reloader: CertReloader | null = null;
  if (tlsMaterial) {
    reloader = createCertReloader({
      initial: tlsMaterial,
      load: () => loadTlsMaterial(config.tls, config.allowedHosts, [REPO_ROOT, dirname(config.dbPath)]),
      apply: (m) => (app.server as unknown as TlsServer).setSecureContext(secureContextOptions(m)),
      signature: () => filesSignature(config.tls.certPath, config.tls.keyPath),
      log: app.log,
      intervalMs: config.tls.reloadCheckSeconds * 1000,
      now,
    });
  }

  const routes: RouteInfo[] = [];
  app.decorateRequest('user', null);
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) routes.push({ method: m, url: r.url, access: r.config?.access });
  });

  // Only HTML forms are accepted. No JSON body parser, so no other way in.
  app.removeAllContentTypeParsers();
  await app.register(fastifyFormbody, { bodyLimit: config.bodyLimit });
  await app.register(fastifyCookie);

  // Hourly: drop expired sessions and stale throttle rows, and summarize finished hours of login
  // events before pruning them. A failure is logged by its code only and never stops the server.
  const housekeeping = (): void => {
    try {
      purgeExpiredSessions(db, policy, now());
      pruneThrottle(db, now());
      summarizeLoginEvents(db, now());
    } catch (err) {
      const e = err as { code?: unknown; errcode?: unknown };
      app.log.error({ code: String(e.code ?? 'unknown'), errcode: typeof e.errcode === 'number' ? e.errcode : undefined }, 'housekeeping failed');
    }
  };
  // Invoice runs: the catalog source is chosen by the server config, never by the browser.
  const catalogSource: CatalogSource =
    deps.catalogSource ??
    (config.devCatalogFile
      ? fileCatalogSource(config.devCatalogFile)
      : squareCatalogSource(
          createSquareReader({
            getSetting: settings.getSetting,
            getSecret: settings.getSecret,
            tokenEnvironment: () => settings.squareTokenEnvironment(),
            allowSquareProduction: config.allowSquareProduction,
            fetch: deps.squareFetch,
          }),
          () => settings.getSetting('squareLocationId'),
          now,
        ));
  const modelClient = (): InvoiceModelClient => {
    if (deps.modelClient) return deps.modelClient;
    let key: string | undefined;
    try {
      key = settings.getSecret('anthropicApiKey');
    } catch {
      throw new RunError('The Claude API key in settings is damaged. An admin must enter it again.');
    }
    const problem = apiKeyProblem(key);
    if (problem) throw new RunError(`${problem} An admin must set it in settings.`);
    return createAnthropicModelClient(createInvoiceAnthropicClient(key!));
  };
  const catalogs = createCatalogCache(db);
  // The daily limit and the big price change percent are admin settings, read each time they are
  // needed, so a change on the Settings page applies to the next reading or page view.
  const dailyLimitUsd = (): number => Number(settings.getSetting('dailyLimitUsd'));
  const bigChangePercent = (): number => Number(settings.getSetting('bigChangePercent'));
  // The fish email in Mailchimp (step 11a): its own worker, one task at a time, and the clock that
  // queues the checks with no invoice.
  const mailchimp = createMailchimpService({
    db,
    settings,
    dataDir: dirname(config.dbPath),
    now,
    cfg: deps.mailchimpConfig,
    localConfigPath: deps.mailchimpLocalConfig,
    fetch: deps.mailchimpFetch,
    testOrigin: deps.mailchimpTestOrigin,
    allowWrites: config.allowMailchimpWrites,
    allowSandboxRuns: config.mailchimpFromSandboxRuns,
    // The register prices for the drift check, only with its own setting on (mailchimpDriftCheck,
    // off by default). In Phase 1 the only Square is the sandbox, so turning it on is a test.
    // With live Square on, the register is live Square: the real register prices. In the sandbox it
    // is a test. A saved catalog file is never a register.
    register:
      deps.mailchimpRegister ??
      (config.allowMailchimpWrites && config.mailchimpDriftCheck && catalogSource.kind !== 'file'
        ? async () => {
            const data = await catalogSource.load();
            return registerFromCatalog(data, `the ${catalogSourceLabel(data.source)}${data.source === 'square_production' ? '' : ' (test setting)'}`);
          }
        : undefined),
    registerLabel: deps.mailchimpRegister ? 'the test register' : `the ${catalogSource.label}`,
    driftPercent: () => bigChangePercent(),
    log: { info: (o, m) => appLog?.info(o, m), error: (o, m) => appLog?.error(o, m), warn: (o, m) => appLog?.warn(o, m) },
    auto: deps.startRunner !== false,
  });
  // Sending a run: Square first (decision 1), then the scales through ScaleConnect. Each run goes to
  // the Square it was read in, and only while that is the Square in use (src/square/origins.ts).
  const squareLocationId = deps.squareLocationId ?? ((): string => settings.getSetting('squareLocationId'));
  const squareEnvironmentOrNull = (): SquareEnv | null => {
    try {
      return effectiveEnvironment(settings.getSetting('squareEnvironment'), config.allowSquareProduction);
    } catch {
      return null;
    }
  };
  // A damaged setting counts as the sandbox for these checks: a live run then waits, and says why.
  // Nothing reaches Square with it anyway: every Square client reads the setting and stops.
  const squareEnvironment = (): SquareEnv => squareEnvironmentOrNull() ?? 'sandbox';
  const labelFor = (source: string): string => catalogLabelFor(catalogSource, source);
  const sourceProblem = (source: string): string | null => {
    // A saved catalog file is refused at send. A Square run must match the Square in use now.
    if (envForSource(source) === null) return null;
    return mixedEnvironmentProblem(source, squareEnvironment());
  };
  const sendDeps: SendDeps = {
    db,
    settings,
    catalogs,
    now,
    scaleNames: config.scaleNames,
    catalogLabelFor: labelFor,
    sourceProblem,
    squareEnvironment,
    get bigChangePercent() {
      return bigChangePercent();
    },
    approvalMaxAgeMs: config.approvalMaxAgeHours * 3600_000,
    writeScales: config.writeScales.filter((n) => config.scaleNames.includes(n)),
    scalePreflight:
      deps.scalePreflight ??
      (() => {
        if (deps.scaleApi) return null;
        return scalePreflightProblem({
          url: () => settings.getSetting('scaleConnectUrl'),
          token: () => settings.getSecret('scaleConnectToken'),
          allowLive: config.allowLiveScaleConnect,
          liveUrl: config.liveScaleConnectUrl,
        });
      }),
    squareLocationId,
    afterSquareDone: (runId, hash, report, source) => mailchimp.afterSquareDone(runId, hash, report, source),
    squareApi: (env) =>
      deps.squareWriteApi ??
      createSquareWriteApi({
        getSetting: settings.getSetting,
        getSecret: settings.getSecret,
        tokenEnvironment: () => settings.squareTokenEnvironment(),
        locationId: squareLocationId,
        fetch: deps.squareFetch,
        now,
        environment: env,
        allowSquareProduction: config.allowSquareProduction,
      }),
    scaleApi:
      deps.scaleApi ??
      (() =>
        connectScaleConnect({
          url: settings.getSetting('scaleConnectUrl'),
          token: settings.getSecret('scaleConnectToken'),
          allowLive: config.allowLiveScaleConnect,
          liveUrl: config.liveScaleConnectUrl,
        })),
    log: { info: (o, m) => appLog?.info(o, m), error: (o, m) => appLog?.error(o, m) },
  };
  const runner = createRunner({
    send: createSendJobs(sendDeps),
    afterDryRun: (runId, preview) => mailchimp.afterDryRun(runId, preview),
    db,
    settings,
    uploadDir: config.uploads.dir,
    scaleNames: config.scaleNames,
    catalogSource,
    catalogs,
    modelClient,
    invoiceSettings: deps.invoiceSettings,
    squareWriter: deps.squareWriter,
    cardCopy: deps.cardCopy,
    get dailyReadingCapUsd() {
      return dailyLimitUsd();
    },
    get bigChangePercent() {
      return bigChangePercent();
    },
    now,
    log: { info: (o, m) => appLog?.info(o, m), error: (o, m) => appLog?.error(o, m) },
    auto: deps.startRunner !== false,
  });

  // Old invoices: read in the background, one at a time, and recorded only. The worker is handed
  // the model client and nothing else: no Square, no scales, no cards, no invoice runs.
  const historyDir = join(dirname(config.dbPath), 'history-uploads');
  const history = createHistoryWorker({
    db,
    settings,
    dir: historyDir,
    modelClient: () => {
      try {
        return modelClient();
      } catch (err) {
        if (err instanceof RunError) throw new HistoryError(err.message);
        throw err;
      }
    },
    invoiceSettings: deps.invoiceSettings,
    dailyLimitUsd,
    historySharePercent: () => Number(settings.getSetting('historySharePercent')),
    now,
    log: { info: (o, m) => appLog?.info(o, m), error: (o, m) => appLog?.error(o, m) },
    auto: deps.startRunner !== false,
  });

  // Shelf card sheets: kept beside the database, checked in the background, one at a time.
  let cardConfig: CardConfig | null = deps.cardConfig ?? null;
  const sheetDeps: SheetDeps = {
    db,
    dir: join(dirname(config.dbPath), 'card-sheets'),
    cardConfig: () => (cardConfig ??= loadCardConfig()),
    now,
    // The same free space floor as invoice uploads.
    limits: { minFreeBytes: config.uploads.minFreeBytes },
  };
  const sheetChecker = createSheetChecker({
    ...sheetDeps,
    check: deps.cardSheetCheck ?? renderSheetCheck(),
    log: { info: (o, m) => appLog?.info(o, m), error: (o, m) => appLog?.error(o, m) },
    auto: deps.startRunner !== false,
  });

  // Upload slots, shared by the invoice run upload and the old invoice upload.
  const uploadSlots = createUploadSlots();
  app.decorate('shelf', { db, settings, config, routes, userKey, housekeeping, runner, catalogSource, sheetChecker, mailchimp, history, uploadSlots, listeners, tlsReload: () => (reloader ? reloader.check() : 'off') });
  const purge = setInterval(housekeeping, 60 * 60 * 1000);
  purge.unref();
  housekeeping();
  // On close: the store network and tailnet listeners stop taking connections, and requests still
  // in progress anywhere get shutdownGraceSeconds to finish before onClose closes the database.
  // Idle connections are closed meanwhile; any handed-in connection left at the end is closed.
  // Node's own close does not wait for connections handed in from those listeners, and Fastify
  // does not count requests, so the count is kept here (see the first onRequest hook).
  app.addHook('preClose', async () => {
    listeners.stopAccepting();
    // The real clock, not the app clock: tests hold the app clock still.
    const until = Date.now() + config.shutdownGraceSeconds * 1000;
    app.server.closeIdleConnections();
    while (inFlight > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      app.server.closeIdleConnections();
    }
    if (inFlight > 0) app.log.warn({ requests: inFlight }, 'closing with requests still running after the grace period');
    listeners.closeAll();
  });
  app.addHook('onClose', async () => {
    clearInterval(purge);
    reloader?.stop();
    await runner.stop();
    await history.stop();
    await sheetChecker.stop();
    await mailchimp.stop();
    db.close();
  });

  const actorOf = (req: FastifyRequest): AuditActor =>
    req.user ? { userId: req.user.userId, username: req.user.username, ip: req.ip } : { userId: null, username: 'anonymous', ip: req.ip };
  const audit = (req: FastifyRequest, entry: Parameters<typeof appendAudit>[2], actor: AuditActor = actorOf(req)): void => {
    appendAudit(db, actor, entry, now());
  };

  const sendPage = (reply: FastifyReply, status: number, body: string): FastifyReply =>
    reply.code(status).type('text/html; charset=utf-8').send(body);

  const setSessionCookie = (reply: FastifyReply, token: string, remember: boolean): void => {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure,
      ...(remember ? { maxAge: Math.floor(policy.rememberMs / 1000) } : {}),
    });
  };
  const clearSessionCookie = (reply: FastifyReply): void => {
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure });
  };

  const needsReauth = (u: SessionUser): boolean => now() - u.authAt > reauthMs;

  /**
   * Checks a password with throttling. The lock check and the attempt count happen together,
   * synchronously, before the hash is awaited, so parallel attempts cannot all get past the lock.
   */
  async function checkPassword(username: string, ip: string, password: string, hash: string): Promise<'ok' | 'bad' | 'locked' | 'busy'> {
    if (!limiter.tryAcquire()) return 'busy';
    try {
      const key = userKey(username);
      if (!beginAttempt(db, key, ip, now(), config.throttle).ok) return 'locked';
      if (!(await verifyPassword(password, hash))) return 'bad';
      attemptSucceeded(db, key, ip, config.throttle);
      return 'ok';
    } finally {
      limiter.release();
    }
  }

  // Requests in progress, counted from the first hook until the response is sent or the client
  // goes, so closing can wait for them (preClose above). Each request is counted down once.
  app.addHook('onRequest', async (req) => {
    inFlight++;
    (req as CountedRequest)[COUNTED] = true;
  });
  const countDown = async (req: FastifyRequest): Promise<void> => {
    const r = req as CountedRequest;
    if (r[COUNTED]) {
      r[COUNTED] = false;
      inFlight--;
    }
  };
  app.addHook('onResponse', countDown);
  app.addHook('onRequestAbort', countDown);

  // First of all: a request for any name but ours is refused, before a session is looked up or a
  // body is read. This stops DNS rebinding, where a page on another name points that name at this
  // PC. The loopback names are answered only on this PC's own loopback address.
  app.addHook('onRequest', async (req, reply) => {
    if (hostAllowed(req.headers.host, req.socket?.localAddress, config.allowedHosts)) return;
    req.log.warn({ path: req.url.split('?')[0] }, 'refused a request for another host name');
    return reply
      .code(421)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .header('Connection', 'close')
      .send('This server does not answer to that name.\n');
  });

  // Every request but the invoice upload must arrive in full within formTimeoutSeconds, so a slow
  // sender cannot hold sign in open for the minutes an upload is allowed. The timer stops once the
  // body is in (preValidation). The upload reads its body in the route, under requestTimeout.
  const formMs = Math.round(config.formTimeoutSeconds * 1000);
  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.multipartCsrf === true) return;
    const timer = setTimeout(() => {
      req.log.info({ path: req.url.split('?')[0] }, 'closed a request that was too slow to arrive');
      req.raw.destroy();
    }, formMs);
    timer.unref();
    (req as TimedRequest)[FORM_TIMER] = timer;
  });
  const clearFormTimer = async (req: FastifyRequest): Promise<void> => clearTimeout((req as TimedRequest)[FORM_TIMER]);
  app.addHook('preValidation', clearFormTimer);
  app.addHook('onResponse', clearFormTimer);
  app.addHook('onRequestAbort', clearFormTimer);

  // Every request runs inside the app's look, so pages take the right branding without a global.
  // The look is set when the static files are registered, before the server takes requests.
  let look: Look;
  app.addHook('onRequest', (_req, _reply, done) => {
    runWithLook(look, done);
  });

  // Security headers on every response, errors included.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    // same-origin, not no-referrer: no-referrer makes browsers send Origin: null on our own forms.
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('Cache-Control', 'no-store');
    // HSTS only for the host names in allowedHosts. Not for localhost (a browser would apply it to
    // every port on this PC), and not for a bare address (browsers ignore it there anyway).
    const requested = hostName(req.headers.host) ?? '';
    if (config.tls.enabled && isDnsName(requested) && config.allowedHosts.includes(requested)) {
      reply.header('Strict-Transport-Security', `max-age=${config.tls.hstsMaxAgeSeconds}`);
    }
  });

  // Every state-changing request must come from one of our own pages.
  app.addHook('onRequest', async (req, reply) => {
    if (isRead(req)) return;
    if (!originAllowed(req.headers, config.publicOrigins)) {
      req.log.warn({ path: req.url.split('?')[0] }, 'refused a request from another origin');
      return sendPage(reply, 403, errorPage(403, 'That request did not come from this app. Reload the page and try again.'));
    }
  });

  // Who is signed in, and may they use this route. All before the body is read.
  app.addHook('onRequest', async (req, reply) => {
    // Static and legal files are public and need no session, so skip only the session lookup, and
    // only when the matched route says public. Every access check below still runs for any other
    // route, even one under /static/.
    const skipSession = req.routeOptions.url !== undefined && req.routeOptions.config?.access === 'public' && (req.url.startsWith('/static/') || req.url.startsWith('/legal/'));
    const token = skipSession ? undefined : req.cookies[SESSION_COOKIE];
    if (token) {
      const u = lookupSession(db, token, policy, now());
      if (u) req.user = u;
      else clearSessionCookie(reply);
    }
    // Not-found requests have no route config. The not-found handler deals with them.
    if (req.routeOptions.url === undefined) return;
    const cfg = req.routeOptions.config;
    const access = cfg?.access;
    if (access === undefined) {
      req.log.error({ path: req.routeOptions.url }, 'route has no access level');
      return sendPage(reply, 500, errorPage(500, 'This page is not set up correctly.'));
    }
    if (access === 'public') return;
    const u = req.user;
    if (!u) {
      if (isRead(req)) return reply.redirect('/login', 303);
      return sendPage(reply, 401, errorPage(401, 'Please sign in again.'));
    }
    if (u.mustChangePassword && !cfg.allowWhenMustChange) {
      if (isRead(req)) return reply.redirect('/account', 303);
      return sendPage(reply, 403, errorPage(403, 'Please choose your own password first.', u));
    }
    if (access === 'admin' && u.role !== 'admin') {
      req.log.warn({ path: req.routeOptions.url, user: u.username }, 'manager refused an admin page');
      return sendPage(reply, 403, errorPage(403, 'You do not have access to that page.', u));
    }
  });

  // The per-session CSRF token on every state-changing request, then a recent password for admin changes.
  app.addHook('preHandler', async (req, reply) => {
    const u = req.user;
    if (isRead(req) || !u || req.routeOptions.url === undefined || req.routeOptions.config?.access === 'public') return;
    // The upload checks its token itself, as the first multipart part, before reading any file.
    // It still gets the recent-password check below if it is ever made an admin route.
    const multipart = req.routeOptions.config?.multipartCsrf === true;
    let sent: string;
    try {
      sent = field(req, '_csrf');
    } catch {
      sent = '';
    }
    if (!multipart && !tokensEqual(sent, u.csrfToken)) {
      req.log.warn({ path: req.routeOptions.url, user: u.username }, 'refused a form with a bad csrf token');
      return sendPage(reply, 403, errorPage(403, 'That form has expired. Reload the page and try again.', u));
    }
    const cfg = req.routeOptions.config;
    if (((cfg.access === 'admin' && !cfg.reauthExempt) || cfg.recentPassword === true) && needsReauth(u)) {
      const runMatch = /^\/runs\/([1-9][0-9]{0,9})(\/send)?/.exec(req.url);
      const historyMatch = /^\/history\/([1-9][0-9]{0,9})\//.exec(req.url);
      const next = req.routeOptions.url.startsWith('/users')
        ? '/users'
        : req.routeOptions.url.startsWith('/mailchimp/')
          ? '/'
          : runMatch
            ? `/runs/${runMatch[1]}${runMatch[2] ?? ''}`
            : historyMatch
              ? `/history/${historyMatch[1]}`
              : '/settings';
      return sendPage(
        reply,
        403,
        layout({
          title: 'Confirm it is you',
          user: u,
          body: html`<p class="error" role="alert">Nothing was changed. Confirm your password, then make the change again.</p>${reauthBox(u, next, config.reauthMinutes)}`,
        }),
      );
    }
  });

  app.setNotFoundHandler((req, reply) => sendPage(reply, 404, errorPage(404, 'There is no page here.', req.user)));

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof BadForm) return sendPage(reply, 400, errorPage(400, 'That form was not filled in as expected.', req.user));
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'request failed');
    const msg =
      status === 413 ? 'That was too large.' : status === 415 ? 'That kind of upload is not accepted here.' : status === 500 ? 'Something went wrong. Try again.' : 'That request could not be handled.';
    return sendPage(reply, status, errorPage(status, msg, req.user));
  });

  // Static files for the app's look: a fixed list, nothing read from a path the browser picks.
  // The pages take the branding and file versions from here.
  const assets = registerStatic(app, config.branding, deps.extraFontDirs);
  look = assets;

  app.get('/about', { config: { access: 'public' } }, async (req, reply) => sendPage(reply, 200, aboutPage(req.user)));

  // Sign in. A random token in a short-lived cookie must match the form, so another site
  // cannot sign a browser in to an account of its choosing.
  const newLoginCsrf = (reply: FastifyReply): string => {
    const csrf = randomBytes(32).toString('base64url');
    reply.setCookie(LOGIN_COOKIE, csrf, { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: 60 * 60 });
    return csrf;
  };

  app.get('/login', { config: { access: 'public' } }, async (req, reply) => {
    if (req.user) return reply.redirect('/', 303);
    return sendPage(reply, 200, loginPage({ csrf: newLoginCsrf(reply) }));
  });

  app.post('/login', { config: { access: 'public' } }, async (req, reply) => {
    const username = field(req, 'username').trim().slice(0, 64);
    const password = field(req, 'password');
    const remember = field(req, 'remember') === '1';
    const again = (status: number, error: string): FastifyReply => sendPage(reply, status, loginPage({ csrf: newLoginCsrf(reply), username, error }));
    if (!tokensEqual(field(req, '_csrf'), req.cookies[LOGIN_COOKIE] ?? '')) {
      return again(403, 'That form has expired. Please try again.');
    }
    const user = username ? findUserByUsername(db, username) : undefined;
    const result = await checkPassword(username, req.ip, password, user && !user.disabled ? user.passwordHash : dummyHash);
    if (result === 'busy' || result === 'locked') {
      recordLoginEvent(db, result, now());
      return again(429, result === 'busy' ? BUSY : LOGIN_FAILED);
    }
    if (result === 'bad' || !user) {
      if (user) {
        // Known accounts get their own audit line. Unknown names go to the prunable events table,
        // in case a password was typed into the username box, and so they cannot fill the audit log.
        audit(req, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, details: { username: user.username, disabled: user.disabled } });
      } else {
        recordLoginEvent(db, 'unknown_user', now());
      }
      return again(401, LOGIN_FAILED);
    }
    // A fresh token every time, and any old session from this browser ends.
    if (req.user) deleteSession(db, req.user.sessionHash);
    const s = createSession(db, user.id, { remember, policy, now: now(), ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    setSessionCookie(reply, s.token, remember);
    reply.clearCookie(LOGIN_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure });
    audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id, details: { remember } }, { userId: user.id, username: user.username, ip: req.ip });
    return reply.redirect(user.mustChangePassword ? '/account' : '/', 303);
  });

  app.post('/logout', { config: { access: 'user', allowWhenMustChange: true } }, async (req, reply) => {
    const u = req.user!;
    deleteSession(db, u.sessionHash);
    clearSessionCookie(reply);
    audit(req, { action: 'auth.logout', entityType: 'user', entityId: u.userId });
    return reply.redirect('/login', 303);
  });

  // Type the password again, for admin changes and for sending a run (managers too). next is one
  // of a fixed list, never a free URL; a manager goes back only to an invoice run.
  app.post('/reauth', { config: { access: 'user', reauthExempt: true } }, async (req, reply) => {
    const u = req.user!;
    const asked = reauthNext(field(req, 'next'));
    const next = u.role === 'admin' || asked.startsWith('/runs/') ? asked : '/runs';
    const full = findUserByUsername(db, u.username);
    const result = await checkPassword(u.username, req.ip, field(req, 'password'), full?.passwordHash ?? dummyHash);
    if (result !== 'ok') {
      // Only a wrong password is worth an audit line. Locked and busy refusals ran no hash,
      // so they only count toward the hourly summary, like sign in.
      if (result === 'bad') audit(req, { action: 'auth.reauth_failed', entityType: 'user', entityId: u.userId });
      else recordLoginEvent(db, result, now());
      const msg = result === 'busy' ? BUSY : result === 'locked' ? 'Too many tries. Wait a few minutes.' : 'That password is not right.';
      return sendPage(reply, result === 'bad' ? 400 : 429, layout({ title: 'Confirm it is you', user: u, body: html`<p class="error" role="alert">${msg}</p>${reauthBox(u, next, config.reauthMinutes)}` }));
    }
    markReauth(db, u.sessionHash, now());
    audit(req, { action: 'auth.reauth', entityType: 'user', entityId: u.userId });
    return reply.redirect(next.startsWith('/runs/') || next.startsWith('/history/') ? next : `${next}?notice=confirmed`, 303);
  });

  app.get('/', { config: { access: 'user' } }, async (req, reply) => {
    const u = req.user!;
    const old = u.role === 'admin' ? mailchimpOldHeld(u, oldHeld(db, now())) : html``;
    return sendPage(reply, 200, homePage(u, html`${mailchimpAlerts(u, openAlerts(db))}${old}`));
  });

  // An admin sets aside one fish email price change held over three weeks, so it is no longer
  // listed. Admin only, so it needs the password typed recently; the CSRF token is checked like
  // every post; audited with the admin's name, the row and the price.
  app.post('/mailchimp/held/:id/dismiss', { config: { access: 'admin' } }, async (req, reply) => {
    const id = idParam(req);
    const row = dismissHeld(db, id, req.user!.username, now());
    if (row) audit(req, { action: 'mailchimp.held_dismissed', entityType: 'mailchimp_held', entityId: id, details: { row: row.rowKey, toCents: row.toCents, day: row.day, runId: row.runId } });
    return reply.redirect('/', 303);
  });

  // A person has seen a fish email alert or note, or dealt with it. Audited with who and when.
  app.post('/mailchimp/alerts/:id/clear', { config: { access: 'user' } }, async (req, reply) => {
    const id = idParam(req);
    if (clearAlert(db, id, req.user!.username, now())) audit(req, { action: 'mailchimp.alert_cleared', entityType: 'mailchimp_task', entityId: id });
    return reply.redirect('/', 303);
  });

  // Account: change own password, sign out everywhere.
  app.get('/account', { config: { access: 'user', allowWhenMustChange: true } }, async (req, reply) =>
    sendPage(reply, 200, accountPage({ user: req.user!, minLength: config.passwordMinLength, notice: notice(req) })),
  );

  app.post('/account/password', { config: { access: 'user', allowWhenMustChange: true } }, async (req, reply) => {
    const u = req.user!;
    const current = field(req, 'current');
    const next = field(req, 'password');
    const confirm = field(req, 'confirm');
    const fail = (status: number, error: string): FastifyReply => sendPage(reply, status, accountPage({ user: u, minLength: config.passwordMinLength, error }));
    const full = findUserByUsername(db, u.username);
    const result = await checkPassword(u.username, req.ip, current, full?.passwordHash ?? dummyHash);
    if (result === 'busy' || result === 'locked') recordLoginEvent(db, result, now());
    if (result === 'busy') return fail(429, BUSY);
    if (result === 'locked') return fail(429, 'Too many tries. Wait a few minutes.');
    if (result === 'bad') return fail(400, 'The current password is not right.');
    if (next !== confirm) return fail(400, 'The two new passwords do not match.');
    if (next === current) return fail(400, 'Choose a password different from the current one.');
    try {
      await setPassword(db, u.userId, next, { ...pwOpts, actor: actorOf(req), byAdmin: false, now: now() });
    } catch (err) {
      if (err instanceof UserError) return fail(400, err.message);
      throw err;
    }
    // setPassword ended every session. Start a new one for this device only.
    const s = createSession(db, u.userId, { remember: u.remember, policy, now: now(), ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    setSessionCookie(reply, s.token, u.remember);
    return reply.redirect('/account?notice=password', 303);
  });

  app.post('/account/sign-out-everywhere', { config: { access: 'user', allowWhenMustChange: true } }, async (req, reply) => {
    const u = req.user!;
    const n = deleteUserSessions(db, u.userId);
    clearSessionCookie(reply);
    audit(req, { action: 'auth.sign_out_everywhere', entityType: 'user', entityId: u.userId, details: { sessions: n } });
    return reply.redirect('/login', 303);
  });

  // Settings: admin only.
  const secretStatuses = (): Record<SecretName, SecretStatus> => {
    const out = {} as Record<SecretName, SecretStatus>;
    for (const n of SECRET_NAMES) out[n] = settings.secretStatus(n);
    return out;
  };

  const settingsView = (req: FastifyRequest, reply: FastifyReply, status: number, form?: SettingsForm, error?: string): FastifyReply => {
    const v = settings.view();
    return sendPage(
      reply,
      status,
      settingsPage({
        user: req.user!,
        form: form ?? settingsFormFrom(v.values, v.damaged),
        saved: v.values,
        secrets: secretStatuses(),
        damaged: v.damaged,
        productionLocked: v.productionLocked,
        allowSquareProduction: config.allowSquareProduction,
        inUse: {
          squareLive: squareEnvironmentOrNull() === 'production',
          squareLabel: ((e) => (e === null ? 'not known, because the saved environment is damaged. Choose it again below' : catalogSourceLabel(sourceForEnv(e))))(squareEnvironmentOrNull()),
          squareTokenFor: ((): string => {
            try {
              const e = settings.squareTokenEnvironment();
              return e === null ? '' : catalogSourceLabel(sourceForEnv(e));
            } catch {
              return '';
            }
          })(),
          scalesLive: config.allowLiveScaleConnect,
          scales: config.allowLiveScaleConnect ? config.writeScales.filter((n) => config.scaleNames.includes(n)) : [],
          liveScaleConnectUrl: config.liveScaleConnectUrl,
        },
        needsReauth: needsReauth(req.user!),
        reauthMinutes: config.reauthMinutes,
        error,
        notice: error ? undefined : notice(req),
        // Read fresh on each view. Nothing here is secret; the key is never read for it.
        certificate: readCertStatus(config.tls.certPath, config.tls.statusPath, now()),
        network: {
          tls: config.tls.enabled,
          port: config.port,
          host: config.host,
          allowedHosts: config.allowedHosts,
          listenAddresses: config.listenAddresses,
          listening: listeners.listening(),
          inUse: [...listeners.problems()].filter(([, p]) => p === 'in-use').map(([a]) => a),
          hstsMaxAgeSeconds: config.tls.hstsMaxAgeSeconds,
        },
      }),
    );
  };

  app.get('/settings', { config: { access: 'admin' } }, async (req, reply) => settingsView(req, reply, 200));

  app.post('/settings', { config: { access: 'admin' } }, async (req, reply) => {
    const form: SettingsForm = {
      anthropicFirstPassModel: field(req, 'anthropicFirstPassModel'),
      anthropicFallbackModel: field(req, 'anthropicFallbackModel'),
      invoiceCostCapUsd: field(req, 'invoiceCostCapUsd'),
      cardCopyCapUsd: field(req, 'cardCopyCapUsd'),
      dailyLimitUsd: field(req, 'dailyLimitUsd'),
      historySharePercent: field(req, 'historySharePercent'),
      bigChangePercent: field(req, 'bigChangePercent'),
      squareEnvironment: field(req, 'squareEnvironment'),
      squareLocationId: field(req, 'squareLocationId'),
      scaleConnectUrl: field(req, 'scaleConnectUrl'),
      cardConfigPath: field(req, 'cardConfigPath'),
      pricingAddBefore: field(req, 'pricingAddBefore'),
      pricingMultiplier: field(req, 'pricingMultiplier'),
      pricingAddAfter: field(req, 'pricingAddAfter'),
      pricingRounding: field(req, 'pricingRounding'),
      pricingVendors: field(req, 'pricingVendors'),
    };
    const secrets: SettingsChange['secrets'] = {};
    for (const n of SECRET_NAMES) {
      const v = field(req, `secret_${n}`);
      if (field(req, `clear_${n}`) === '1') secrets[n] = null;
      else if (v.trim() !== '') secrets[n] = v;
    }
    try {
      const values: Partial<SettingValues> = {
        anthropicFirstPassModel: form.anthropicFirstPassModel,
        anthropicFallbackModel: form.anthropicFallbackModel,
        invoiceCostCapUsd: form.invoiceCostCapUsd,
        cardCopyCapUsd: form.cardCopyCapUsd,
        dailyLimitUsd: form.dailyLimitUsd,
        historySharePercent: form.historySharePercent,
        bigChangePercent: form.bigChangePercent,
        squareEnvironment: form.squareEnvironment as SettingValues['squareEnvironment'],
        squareLocationId: form.squareLocationId,
        scaleConnectUrl: form.scaleConnectUrl,
        cardConfigPath: form.cardConfigPath,
        pricing: {
          default: {
            addBefore: form.pricingAddBefore,
            multiplier: form.pricingMultiplier,
            addAfter: form.pricingAddAfter,
            rounding: form.pricingRounding as 'up-to-99',
          },
          vendors: parseVendorLines(form.pricingVendors),
        },
      };
      // A damaged value is shown blank. Left blank, it is left out of the save, so saving another
      // field does not touch it. Any value posted, the default included, repairs it.
      for (const name of settings.view().damaged) {
        if (formFieldsFor(name).every((f) => form[f].trim() === '')) delete values[name];
      }
      const { changed } = settings.update({ values, secrets }, actorOf(req));
      return reply.redirect(`/settings?notice=${changed.length ? 'saved' : 'nochange'}`, 303);
    } catch (err) {
      if (!(err instanceof SettingError)) throw err;
      // Show what was typed for plain values. Secret boxes always come back empty.
      return settingsView(req, reply, 400, form, `Not saved. ${err.message}`);
    }
  });

  // Users: admin only.
  const usersView = (req: FastifyRequest, reply: FastifyReply, status: number, error?: string): FastifyReply =>
    sendPage(
      reply,
      status,
      usersPage({
        user: req.user!,
        users: listUsers(db),
        minLength: config.passwordMinLength,
        needsReauth: needsReauth(req.user!),
        reauthMinutes: config.reauthMinutes,
        error,
        notice: error ? undefined : notice(req),
      }),
    );

  const userAction = async (req: FastifyRequest, reply: FastifyReply, fn: (id: number) => Promise<void> | void, done: string): Promise<FastifyReply> => {
    const id = idParam(req);
    if (!getUser(db, id)) return usersView(req, reply, 404, 'No such user.');
    try {
      await fn(id);
    } catch (err) {
      if (err instanceof UserError) return usersView(req, reply, 400, err.message);
      throw err;
    }
    return reply.redirect(`/users?notice=${done}`, 303);
  };

  app.get('/users', { config: { access: 'admin' } }, async (req, reply) => usersView(req, reply, 200));

  app.post('/users', { config: { access: 'admin' } }, async (req, reply) => {
    const role = field(req, 'role');
    try {
      if (!isRole(role)) throw new UserError('Pick a role: manager or admin.');
      await createUser(
        db,
        { username: field(req, 'username'), displayName: field(req, 'displayName'), role, password: field(req, 'password'), mustChangePassword: true },
        { ...pwOpts, actor: actorOf(req), now: now() },
      );
    } catch (err) {
      if (err instanceof UserError) return usersView(req, reply, 400, err.message);
      throw err;
    }
    return reply.redirect('/users?notice=created', 303);
  });

  app.post('/users/:id/disable', { config: { access: 'admin' } }, async (req, reply) =>
    userAction(req, reply, (id) => setDisabled(db, id, true, actorOf(req), now()), 'updated'),
  );
  app.post('/users/:id/enable', { config: { access: 'admin' } }, async (req, reply) =>
    userAction(req, reply, (id) => setDisabled(db, id, false, actorOf(req), now()), 'updated'),
  );
  app.post('/users/:id/role', { config: { access: 'admin' } }, async (req, reply) => {
    const role = field(req, 'role');
    return userAction(
      req,
      reply,
      (id) => {
        if (!isRole(role)) throw new UserError('Pick a role: manager or admin.');
        setRole(db, id, role, actorOf(req), now());
      },
      'updated',
    );
  });
  app.post('/users/:id/password', { config: { access: 'admin' } }, async (req, reply) => {
    const password = field(req, 'password');
    return userAction(
      req,
      reply,
      async (id) => {
        // Resetting your own password here would force you to change it again. Use Account instead.
        if (id === req.user!.userId) throw new UserError('Change your own password on the Account page.');
        await setPassword(db, id, password, { ...pwOpts, actor: actorOf(req), byAdmin: true, now: now() });
      },
      'updated',
    );
  });
  app.post('/users/:id/sign-out-everywhere', { config: { access: 'admin' } }, async (req, reply) =>
    userAction(
      req,
      reply,
      (id) => {
        const n = deleteUserSessions(db, id);
        audit(req, { action: 'auth.sign_out_everywhere', entityType: 'user', entityId: id, details: { sessions: n } });
      },
      'signedout',
    ),
  );

  await registerRunRoutes(
    app,
    { sendPage, field, idParam, actorOf, now },
    {
      config,
      runner,
      catalogs,
      catalogSource,
      actions: {
        db,
        settings,
        catalogs,
        now,
        scaleNames: config.scaleNames,
        catalogLabelFor: labelFor,
        sourceProblem,
        get bigChangePercent() {
          return bigChangePercent();
        },
      },
      dailyLimitUsd,
      uploadLimits: { ...DEFAULT_INVOICE_SETTINGS.upload, ...deps.invoiceSettings?.upload },
      sheets: { deps: sheetDeps, checker: sheetChecker },
      uploadSlots,
    },
  );

  await registerSendRoutes(app, { sendPage, field, idParam, actorOf, now }, {
    deps: sendDeps,
    runner,
    where: () => sendWhere(squareEnvironment(), config),
  });

  await registerHistoryRoutes(app, { sendPage, field, idParam, actorOf, now }, {
    config,
    worker: history,
    dir: historyDir,
    uploadLimits: { ...DEFAULT_INVOICE_SETTINGS.upload, ...deps.invoiceSettings?.upload },
    uploadSlots,
  });

  deps.extraRoutes?.(app);
  await app.ready();
  // Both readers book what a restart cut short before either starts new work, so a reading started
  // now is never taken for one cut short. Each books only its own rows.
  history.recover();
  runner.recover();
  // Runs read before the purchase history existed, or whose recording failed, are recorded once.
  backfillRuns(db, now(), readingSettings(settings, deps.invoiceSettings));
  history.kick();
  runner.kick();
  sheetChecker.recover();
  sheetChecker.kick();
  // The fish email worker starts in main.ts, once the server is listening.
  return app;
}
