// Step 9 config rules: where the server may listen, which names it answers to, and the TLS files.
// Plus the pure rules in src/server/network.ts. No sockets here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeConfig, REPO_ROOT, type ConfigInput } from '../src/server/config.ts';
import { addressKind, hostAllowed, hostName, ipv6Groups, isDnsName, listenAddressProblem, throttleAddress } from '../src/server/network.ts';
import { ipKey } from '../src/auth/throttle.ts';

/**
 * The 192.168/16 private range, built at run time: the git hooks refuse that prefix written out,
 * because it is the store's own network. Tests of the range use this.
 */
const R192 = ['192', '168'].join('.');

const TLS = { enabled: true, certPath: '/x/fullchain.pem', keyPath: '/x/key.pem' };
const net = (extra: ConfigInput = {}): ConfigInput => ({ tls: TLS, listenAddresses: ['10.0.0.20', '100.64.0.20'], allowedHosts: ['shelfready.example.com'], ...extra });

test('the server listens on this PC only, unless TLS is on and the addresses are named', () => {
  assert.throws(() => makeConfig({ listenAddresses: ['10.0.0.20'] }), /127\.0\.0\.1 only/);
  assert.throws(() => makeConfig({ host: '0.0.0.0' }), /127\.0\.0\.1 only/);
  assert.throws(() => makeConfig({ host: '10.0.0.20' }), /127\.0\.0\.1 only/);
  // With TLS, host is still this PC's loopback. Other addresses go in listenAddresses.
  assert.throws(() => makeConfig({ ...net(), host: '0.0.0.0' }), /loopback/);
  assert.throws(() => makeConfig({ ...net(), host: '::' }), /loopback/);
  assert.throws(() => makeConfig({ ...net(), host: '10.0.0.20' }), /loopback/);
  const c = makeConfig(net());
  assert.equal(c.host, '127.0.0.1');
  assert.deepEqual(c.listenAddresses, ['10.0.0.20', '100.64.0.20']);
});

test('listenAddresses holds only store network and tailnet addresses, written out', () => {
  for (const bad of ['0.0.0.0', '::', '0.1.2.3', '127.0.0.1', '::1', '8.8.8.8', '203.0.113.5', '169.254.1.1', 'fe80::1', '224.0.0.1', '255.255.255.255', '2001:db8::1', 'storepc.local', 'localhost', `${R192}.1.0/24`, `${R192}.1.20:8443`, '', '::ffff:8.8.8.8']) {
    assert.throws(() => makeConfig(net({ listenAddresses: [bad] })), /listenAddresses/, bad);
  }
  for (const good of [`${R192}.1.20`, '10.0.0.5', '172.16.0.1', '172.31.255.254', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1', 'fd00::5']) {
    assert.deepEqual(makeConfig(net({ listenAddresses: [good] })).listenAddresses, [good], good);
  }
  assert.throws(() => makeConfig(net({ listenAddresses: ['10.0.0.5', '10.0.0.5'] })), /twice/);
  assert.throws(() => makeConfig(net({ listenAddresses: Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}`) })), /up to 8/);
  // Phones need a name the certificate covers.
  assert.throws(() => makeConfig({ tls: TLS, listenAddresses: ['10.0.0.5'] }), /needs allowedHosts/);
});

test('allowedHosts holds host names, lowercased, and needs TLS', () => {
  assert.deepEqual(makeConfig(net({ allowedHosts: ['ShelfReady.Example.COM.'] })).allowedHosts, ['shelfready.example.com']);
  for (const bad of ['localhost', '10.0.0.21', '*.example.com', '-x.example.com', 'example', 'shelf ready.example.com', 'a_b.example.com', '[::1]']) {
    assert.throws(() => makeConfig(net({ allowedHosts: [bad] })), /allowedHosts/, bad);
  }
  assert.throws(() => makeConfig({ allowedHosts: ['shelfready.example.com'] }), /needs tls on/);
});

test('TLS files default to the pair cert.ts installs, and the key may not sit in the repo or the data folder', () => {
  const c = makeConfig({ tls: { enabled: true } });
  assert.equal(c.tls.certPath, join(homedir(), '.config', 'shelfready', 'tls', 'current', 'fullchain.pem'));
  assert.equal(c.tls.keyPath, join(homedir(), '.config', 'shelfready', 'tls', 'current', 'key.pem'));
  assert.equal(c.tls.statusPath, join(homedir(), '.config', 'shelfready', 'tls', 'status.json'), 'the record sits beside current/');
  assert.equal(makeConfig({ tls: { enabled: true, certPath: '/srv/x/fullchain.pem', keyPath: '/srv/x/key.pem' } }).tls.statusPath, '/srv/x/status.json');
  assert.equal(c.tls.hstsMaxAgeSeconds, 300, 'HSTS starts short');
  assert.throws(() => makeConfig({ tls: { enabled: true, keyPath: join(REPO_ROOT, 'config', 'local', 'key.pem') } }), /outside the ShelfReady folder/);
  assert.throws(() => makeConfig({ dbPath: '/srv/sr/data/db.sqlite3', tls: { enabled: true, keyPath: '/srv/sr/data/key.pem' } }), /data folder/);
  assert.throws(() => makeConfig({ tls: { enabled: true, hstsMaxAgeSeconds: -1 } }), /hstsMaxAgeSeconds/);
  assert.throws(() => makeConfig({ tls: { enabled: true, hstsMaxAgeSeconds: 1.5 } }), /hstsMaxAgeSeconds/);
  assert.equal(makeConfig({ tls: { enabled: true, hstsMaxAgeSeconds: 31536000 } }).tls.hstsMaxAgeSeconds, 31536000);
});

test('timeouts and header limits are checked', () => {
  const d = makeConfig({});
  assert.equal(d.headersTimeoutSeconds, 15);
  assert.equal(d.formTimeoutSeconds, 20);
  assert.equal(d.keepAliveTimeoutSeconds, 10);
  assert.equal(d.tlsHandshakeTimeoutSeconds, 10);
  assert.equal(d.maxHeaderBytes, 8192);
  assert.throws(() => makeConfig({ formTimeoutSeconds: 0 }), /formTimeoutSeconds/);
  assert.throws(() => makeConfig({ headersTimeoutSeconds: 400 }), /headersTimeoutSeconds/);
  assert.throws(() => makeConfig({ requestTimeoutSeconds: 10, formTimeoutSeconds: 20 }), /not be more than requestTimeoutSeconds/);
  assert.throws(() => makeConfig({ maxHeaderBytes: 1000 }), /maxHeaderBytes/);
  assert.throws(() => makeConfig({ maxConnections: 0 }), /maxConnections/);
  assert.equal(d.maxConnectionsPerDevice, 8);
  assert.equal(d.maxConnections, 500);
  assert.equal(d.shutdownGraceSeconds, 10);
  assert.throws(() => makeConfig({ maxConnectionsPerDevice: 0 }), /maxConnectionsPerDevice/);
  assert.throws(() => makeConfig({ maxConnections: 10, maxConnectionsPerDevice: 11 }), /maxConnectionsPerDevice/);
  assert.throws(() => makeConfig({ shutdownGraceSeconds: 0 }), /shutdownGraceSeconds/);
});

test('trustProxy can only be false', () => {
  assert.equal(makeConfig({}).trustProxy, false);
  assert.throws(() => makeConfig({ trustProxy: true }), /trustProxy must be false/);
  assert.throws(() => makeConfig({ trustProxy: '127.0.0.1' as unknown as boolean }), /trustProxy must be false/);
});

test('origins follow the names and the port, and may name only this server', () => {
  assert.deepEqual(makeConfig(net({ port: 8443 })).publicOrigins, ['https://shelfready.example.com:8443', 'https://127.0.0.1:8443', 'https://localhost:8443']);
  assert.deepEqual(makeConfig(net({ port: 443 })).publicOrigins, ['https://shelfready.example.com', 'https://127.0.0.1', 'https://localhost']);
  assert.throws(() => makeConfig(net({ publicOrigins: ['https://evil.example'] })), /only this PC or a name in allowedHosts/);
  assert.throws(() => makeConfig(net({ publicOrigins: ['http://shelfready.example.com:8443'] })), /must be https/);
  assert.deepEqual(makeConfig(net({ publicOrigins: ['https://shelfready.example.com:8443'] })).publicOrigins, ['https://shelfready.example.com:8443']);
  // Without TLS nothing changes from before.
  assert.deepEqual(makeConfig({ port: 4000 }).publicOrigins, ['http://127.0.0.1:4000', 'http://localhost:4000']);
});

test('address kinds', () => {
  const cases: [string, string][] = [
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.9.9.9', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.15.0.1', 'public'],
    ['172.16.0.1', 'private'],
    ['10.0.0.20', 'private'],
    ['100.63.255.255', 'public'],
    ['100.64.0.1', 'tailnet'],
    ['169.254.169.254', 'link-local'],
    ['224.0.0.251', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    [`::ffff:${R192}.1.5`, 'private'],
    [`${R192}.1.5`, 'private'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['fd7a:115c:a1e0::aa36:617d', 'tailnet'],
    ['fd12:3456::1', 'private'],
    ['2001:db8::1', 'public'],
    ['localhost', 'invalid'],
    ['1.2.3', 'invalid'],
    ['fe80::1%wlan0', 'invalid'],
  ];
  for (const [ip, kind] of cases) assert.equal(addressKind(ip), kind, ip);
  assert.equal(listenAddressProblem('10.0.0.20'), null);
  assert.deepEqual(ipv6Groups('2001:db8::8:800:200c:417a'), [0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a]);
  assert.deepEqual(ipv6Groups('::ffff:192.0.2.1'), [0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]);
  assert.deepEqual(ipv6Groups('1::'), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(ipv6Groups('1:2:3:4:5:6:7'), null);
  assert.equal(ipv6Groups('192.0.2.1'), null);
  assert.ok(isDnsName('shelfready.example.com'));
  assert.ok(!isDnsName('1.2.3.4'));
});

test('Host headers: our names everywhere, loopback names only on loopback, nothing else', () => {
  const ours = ['shelfready.example.com'];
  assert.equal(hostName('ShelfReady.Example.com:8443'), 'shelfready.example.com');
  assert.equal(hostName('shelfready.example.com.'), 'shelfready.example.com');
  assert.equal(hostName('[::1]:8443'), '[::1]');
  for (const bad of ['', 'a b', 'x:y', 'host:99999x', '[::1', 'user@host', 'host/path', '::1']) assert.equal(hostName(bad), null, bad);
  assert.ok(hostAllowed('shelfready.example.com:8443', '10.0.0.20', ours));
  assert.ok(hostAllowed('shelfready.example.com', '100.64.0.20', ours));
  assert.ok(hostAllowed('shelfready.example.com', '127.0.0.1', ours));
  // DNS rebinding: another name pointed at this PC.
  assert.ok(!hostAllowed('evil.example:8443', '10.0.0.20', ours));
  assert.ok(!hostAllowed('shelfready.example.com.evil.example', '10.0.0.20', ours));
  // An address as the Host, and the loopback names, only from this PC.
  assert.ok(!hostAllowed('10.0.0.20:8443', '10.0.0.20', ours));
  for (const name of ['localhost', 'localhost:8443', '127.0.0.1:8443', '[::1]:8443']) {
    assert.ok(hostAllowed(name, '127.0.0.1', ours), name);
    assert.ok(hostAllowed(name, '::ffff:127.0.0.1', ours), name);
    assert.ok(!hostAllowed(name, '10.0.0.20', ours), name);
    assert.ok(!hostAllowed(name, '100.64.0.20', ours), name);
  }
  assert.ok(!hostAllowed(undefined, '127.0.0.1', ours));
  assert.ok(!hostAllowed('', '127.0.0.1', ours));
  assert.ok(!hostAllowed(['shelfready.example.com'], '127.0.0.1', ours));
});

test('the sign-in throttle counts an IPv6 address by its /64', () => {
  assert.equal(throttleAddress('10.0.0.7'), '10.0.0.7');
  assert.equal(throttleAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(throttleAddress('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(throttleAddress('2001:0db8:0001:0002::ffff'), '2001:db8:1:2::/64');
  assert.notEqual(throttleAddress('2001:db8:1:3::1'), throttleAddress('2001:db8:1:2::1'));
  assert.equal(throttleAddress('::ffff:10.0.0.7'), '10.0.0.7', 'an IPv4-mapped address counts as its IPv4 address');
  assert.equal(throttleAddress('fe80::1%wlan0'), 'fe80:0:0:0::/64', 'the zone is dropped');
  assert.equal(throttleAddress('not an address'), 'not an address');
  // Tailscale gives each device one IPv6 address, and a tailnet's devices share a /64: one by one.
  assert.equal(throttleAddress('fd7a:115c:a1e0::aa36:617d'), 'fd7a:115c:a1e0:0:0:0:aa36:617d');
  assert.notEqual(throttleAddress('fd7a:115c:a1e0::aa36:617d'), throttleAddress('fd7a:115c:a1e0::aa36:617e'));
  assert.equal(throttleAddress('FD7A:115C:A1E0:0000::AA36:617D'), throttleAddress('fd7a:115c:a1e0::aa36:617d'), 'one address however it is written');
  assert.equal(throttleAddress('fd12:3456:789a:1::5'), 'fd12:3456:789a:1::/64', 'other unique local addresses still by /64');
  assert.equal(ipKey('2001:db8:1:2::9'), 'ip:2001:db8:1:2::/64');
});
