// The sign-in throttle counts IPv6 addresses by their /64, so a phone hopping between addresses in
// its own /64 cannot dodge the per-address limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, addUser, login, makeApp } from './server-helpers.ts';

test('failures from different addresses in one IPv6 /64 lock that /64, and only it', async (t) => {
  const s = await makeApp({ throttle: { ipFailures: 3, userFailures: 50, baseLockSeconds: 30, maxLockSeconds: 900, windowMinutes: 60 } });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  for (const [i, ip] of ['2001:db8:1:2::1', '2001:db8:1:2:aaaa::2', '2001:db8:1:2:ffff:ffff:ffff:ffff'].entries()) {
    assert.equal((await login(s, `nobody${i}`, 'wrong password here', false, ip)).status, 401, ip);
  }
  // A new address in the same /64, even with the right password: locked.
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '2001:db8:1:2::77')).status, 429);
  // The next /64 over is not.
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '2001:db8:1:3::1')).status, 303);
  const keys = (s.app.shelf.db.prepare("SELECT key FROM login_throttle WHERE key LIKE 'ip:%'").all() as { key: string }[]).map((r) => r.key);
  assert.ok(keys.includes('ip:2001:db8:1:2::/64'));
  assert.ok(!keys.some((k) => k.includes('aaaa')), 'whole addresses are not stored');
});

test('an IPv4-mapped IPv6 address counts as its IPv4 address', async (t) => {
  const s = await makeApp({ throttle: { ipFailures: 2, userFailures: 50, baseLockSeconds: 30, maxLockSeconds: 900, windowMinutes: 60 } });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  assert.equal((await login(s, 'x1', 'wrong password here', false, '10.0.0.9')).status, 401);
  assert.equal((await login(s, 'x2', 'wrong password here', false, '::ffff:10.0.0.9')).status, 401);
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '10.0.0.9')).status, 429);
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '10.0.0.10')).status, 303);
});

test('Tailscale IPv6 addresses are counted one by one, since a tailnet shares one /64', async (t) => {
  const s = await makeApp({ throttle: { ipFailures: 2, userFailures: 50, baseLockSeconds: 30, maxLockSeconds: 900, windowMinutes: 60 } });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  assert.equal((await login(s, 'x1', 'wrong password here', false, 'fd7a:115c:a1e0::aa36:617d')).status, 401);
  assert.equal((await login(s, 'x2', 'wrong password here', false, 'fd7a:115c:a1e0::aa36:617d')).status, 401);
  assert.equal((await login(s, 'bart', ADMIN_PW, false, 'fd7a:115c:a1e0::aa36:617d')).status, 429, 'that device is locked');
  assert.equal((await login(s, 'bart', ADMIN_PW, false, 'fd7a:115c:a1e0::aa36:6180')).status, 303, 'another tailnet device is not');
});
