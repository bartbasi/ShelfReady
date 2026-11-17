// Development only: reads the store's recent Mailchimp campaigns, so step 11 can be built against
// the real fish email layout. Read only. Mailchimp API keys cannot be limited to reading, so this
// file is the limit:
//   - one private sender, GET only, with a fixed allowlist of paths checked on the parsed URL;
//   - the host is built from the key's own data center, which must look like "us7";
//   - no redirects, and no run with proxy or TLS settings that could send the key elsewhere.
// The key is read from ~/.config/shelfready/dev.env as MAILCHIMP_API_KEY and never printed.
// What it saves goes to data/mailchimp/ (store data, out of git), mode 600 in a mode 700 folder.
//
//   node scripts/mailchimp/read-recent.ts [count]     (count of recent campaigns, 1 to 30, default 12)

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { devEnvValue } from '../lib/dev-env.ts';
import { riskyEnvironment } from '../../src/lib/risky-env.ts';

const ID = /^[a-z0-9]{6,20}$/;
/** The only calls this script sends. All are GET. */
const READ_PATHS: readonly RegExp[] = [
  /^\/3\.0\/ping$/,
  /^\/3\.0\/campaigns$/,
  /^\/3\.0\/campaigns\/[a-z0-9]{6,20}\/content$/,
];

function key(): { key: string; origin: string } {
  const risky = riskyEnvironment();
  if (risky) throw new Error(`Refusing to run: ${risky}`);
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[v]) throw new Error(`Refusing to run with ${v} set: the key must go straight to Mailchimp.`);
  }
  const k = devEnvValue('MAILCHIMP_API_KEY');
  const m = /^[0-9a-f]{32}-(us[0-9]{1,3})$/.exec(k);
  if (!m) throw new Error('MAILCHIMP_API_KEY in dev.env does not look like a Mailchimp key (32 hex characters, a dash, then the data center such as us7).');
  return { key: k, origin: `https://${m[1]}.api.mailchimp.com` };
}

async function get(path: string, params: Record<string, string> = {}): Promise<any> {
  const { key: k, origin } = key();
  const url = new URL(path, origin);
  for (const [n, v] of Object.entries(params)) url.searchParams.set(n, v);
  if (url.origin !== origin || url.username || url.password) throw new Error('Refusing: not the Mailchimp API host.');
  if (!READ_PATHS.some((re) => re.test(url.pathname))) throw new Error(`Refusing GET ${url.pathname}: not a read this script allows.`);
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${k}`, Accept: 'application/json' },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const title = String(json?.title ?? '').split(k).join('[redacted]').replace(/[^A-Za-z0-9 .,'[\]-]/g, '').slice(0, 120);
    throw new Error(`Mailchimp GET ${url.pathname} failed (HTTP ${res.status}) ${title}`);
  }
  return json;
}

function clean(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 200);
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? '12');
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error('count must be a whole number from 1 to 30.');

  await get('/3.0/ping');
  const list = await get('/3.0/campaigns', {
    count: String(count),
    sort_field: 'create_time',
    sort_dir: 'DESC',
    fields: 'campaigns.id,campaigns.status,campaigns.create_time,campaigns.send_time,campaigns.settings.title,campaigns.settings.subject_line,campaigns.settings.folder_id,campaigns.recipients.list_id,campaigns.recipients.list_name,campaigns.type,total_items',
  });

  const dir = join(import.meta.dirname, '..', '..', 'data', 'mailchimp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const save = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text, { mode: 0o600 });
    chmodSync(p, 0o600);
  };
  save('campaigns.json', JSON.stringify(list, null, 2));

  console.log(`Mailchimp: ${Number(list.total_items) || 0} campaigns in all. The ${count} most recent, newest first:`);
  for (const c of list.campaigns ?? []) {
    const id = String(c.id ?? '');
    console.log(`  ${clean(c.status).padEnd(9)} ${clean(c.send_time || c.create_time).slice(0, 16).padEnd(16)}  "${clean(c.settings?.title)}"  subject "${clean(c.settings?.subject_line)}"  list "${clean(c.recipients?.list_name)}"`);
    if (!ID.test(id)) continue;
    const content = await get(`/3.0/campaigns/${id}/content`, { fields: 'html,plain_text' });
    save(`content-${id}.html`, String(content.html ?? ''));
    save(`content-${id}.txt`, String(content.plain_text ?? ''));
  }
  console.log(`Saved the list and each campaign's content in ${dir} (out of git). Nothing in Mailchimp was changed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Failed.');
  process.exitCode = 1;
});
