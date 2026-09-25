import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Host, Input, Certificate } from '../src/shared/types.js';
import { covers, overlaps, checkCertificate, fingerprint, AppError } from '../src/server/domain.js';
import { mapPorts } from '../src/server/docker.js';
import { Store } from '../src/server/store.js';
import { Manager } from '../src/server/manager.js';
import { buildApp } from '../src/server/app.js';
import type { NpmPort } from '../src/server/npm.js';
const certificate: Certificate = {
  id: 1,
  nice_name: '*.example.com',
  domain_names: ['*.example.com'],
  expires_on: '2099-01-01 00:00:00',
  provider: 'other',
};
const input: Input = {
  subdomain: 'photos',
  port: 18080,
  scheme: 'http',
  certificateId: 1,
  websocket: true,
  project: '',
  service: '',
  containerPort: null,
};
class FakeNpm implements NpmPort {
  rows: Host[] = [];
  lost = false;
  versionText = '2.16.0';
  async version() {
    return this.versionText;
  }
  async certificates() {
    return [certificate];
  }
  async hosts() {
    return structuredClone(this.rows);
  }
  async get(id: number) {
    const h = this.rows.find((h) => h.id === id);
    if (!h) throw new Error('not found');
    return structuredClone(h);
  }
  async create(body: Record<string, unknown>) {
    const h = {
      ...body,
      id: this.rows.length + 1,
      enabled: true,
      advanced_config: '',
      locations: [],
      meta: { ...(body.meta as object), nginx_online: true },
    } as unknown as Host;
    this.rows.push(h);
    if (this.lost) throw new AppError(502, 'timeout');
    return structuredClone(h);
  }
  async update(id: number, p: Record<string, unknown>) {
    const h = this.rows.find((h) => h.id === id)!;
    Object.assign(h, p);
    return structuredClone(h);
  }
  async toggle(id: number, on: boolean) {
    await this.update(id, { enabled: on });
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pdm-test-'));
  const key = join(dir, 'key');
  writeFileSync(key, randomBytes(32).toString('hex'));
  const store = new Store(join(dir, 'test.sqlite'), key);
  store.set('settings', {
    npmUrl: 'http://localhost:81',
    identity: 'a@example.com',
    baseDomain: 'example.com',
    forwardHost: 'host.docker.internal',
    certificateId: 1,
    proxyHost: 'localhost',
    proxyPort: 443,
    expectedIp: '',
    protectedDomains: ['manager.example.com'],
  });
  const npm = new FakeNpm(),
    manager = new Manager(store, () => npm, { services: async () => [] });
  return {
    dir,
    key,
    store,
    npm,
    manager,
    clean: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('certificate wildcard only covers one label, domain conflicts conservative', () => {
  assert.ok(covers('*.example.com', 'photos.example.com'));
  assert.ok(!covers('*.example.com', 'a.photos.example.com'));
  assert.ok(!covers('*.example.com', 'example.com'));
  assert.ok(!covers('*.example.com', 'evil-example.com'));
  assert.ok(overlaps('*.example.com', 'a.photos.example.com'));
  assert.throws(() =>
    checkCertificate({ ...certificate, expires_on: '2020-01-01' }, 'photos.example.com'),
  );
});
test('published host ports map correctly, loopback/UDP excluded and IPv4/IPv6 deduplicated', () => {
  const p = mapPorts({
    '3000/tcp': [
      { HostIp: '0.0.0.0', HostPort: '18080' },
      { HostIp: '::', HostPort: '18080' },
    ],
    '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '9000' }],
    '53/udp': [{ HostIp: '', HostPort: '53' }],
  });
  assert.equal(p.length, 3);
  assert.equal(p[0].hostPort, 18080);
  assert.equal(p[0].containerPort, 3000);
  assert.equal(p.filter((x) => x.eligible).length, 1);
});
test('create is idempotent; conflict includes disabled and wildcard rules', async () => {
  const f = fixture();
  try {
    const key = randomUUID();
    const first = await f.manager.save(input, key);
    assert.equal(first.status, 'applied');
    await f.manager.save(input, key);
    assert.equal(f.npm.rows.length, 1);
    f.npm.rows[0].enabled = false;
    await assert.rejects(async () => f.manager.save(input, randomUUID()), /冲突/);
    f.npm.rows[0].domain_names = ['*.example.com'];
    await assert.rejects(
      async () => f.manager.save({ ...input, subdomain: 'other' }, randomUUID()),
      /冲突/,
    );
  } finally {
    f.clean();
  }
});
test('edits preserve unrelated fields, reject stale state, and rollback restores previous target', async () => {
  const f = fixture();
  try {
    await f.manager.save(input, randomUUID());
    f.npm.rows[0].access_list_id = 42;
    let h = await f.npm.get(1);
    const stale = fingerprint(h);
    f.npm.rows[0].caching_enabled = true;
    await assert.rejects(
      async () => f.manager.save({ ...input, port: 18081 }, randomUUID(), 1, stale),
      /其他位置修改/,
    );
    h = await f.npm.get(1);
    const op = await f.manager.save({ ...input, port: 18081 }, randomUUID(), 1, fingerprint(h));
    assert.equal(op.status, 'applied');
    assert.equal(f.npm.rows[0].access_list_id, 42);
    assert.equal(f.npm.rows[0].caching_enabled, true);
    await f.manager.rollback(op.id, randomUUID(), fingerprint(await f.npm.get(1)));
    assert.equal(f.npm.rows[0].forward_port, 18080);
  } finally {
    f.clean();
  }
});
test('archive disables, preserves host, survives persistence, and restores', async () => {
  const f = fixture();
  try {
    await f.manager.save(input, randomUUID());
    await f.manager.change(1, 'archive', randomUUID(), fingerprint(await f.npm.get(1)));
    assert.equal(f.npm.rows.length, 1);
    assert.equal(f.npm.rows[0].enabled, false);
    assert.equal(f.store.binding(1)?.archived, true);
    await assert.rejects(
      async () => f.manager.save(input, randomUUID(), 1, fingerprint(await f.npm.get(1))),
      /恢复归档/,
    );
    await f.manager.change(1, 'restore', randomUUID(), fingerprint(await f.npm.get(1)));
    assert.equal(f.npm.rows[0].enabled, true);
    assert.equal(f.store.binding(1)?.archived, false);
  } finally {
    f.clean();
  }
});
test('ambiguous timeout recovers using operation marker and never creates twice', async () => {
  const f = fixture();
  try {
    f.npm.lost = true;
    const key = randomUUID();
    const o = await f.manager.save(input, key);
    assert.equal(o.status, 'needs_attention');
    await assert.rejects(async () => f.manager.save(input, key), /需要核对/);
    await f.manager.reconcile();
    assert.equal(f.store.byKey(key)?.status, 'applied');
    assert.equal(f.store.binding(1)?.npmId, 1);
    await f.manager.save(input, key);
    assert.equal(f.npm.rows.length, 1);
  } finally {
    f.clean();
  }
});
test('unmanaged, advanced and protected rules cannot be silently changed', async () => {
  const f = fixture();
  try {
    const h = await f.npm.create({
      domain_names: ['photos.example.com'],
      forward_host: 'host.docker.internal',
      forward_port: 18080,
    });
    await assert.rejects(
      async () => f.manager.save(input, randomUUID(), h.id, fingerprint(h)),
      /接管/,
    );
    f.npm.rows[0].advanced_config = 'return 200;';
    await assert.rejects(
      async () => f.manager.adopt(1, fingerprint(await f.npm.get(1))),
      /自定义配置/,
    );
    await assert.rejects(
      async () => f.manager.save({ ...input, subdomain: 'manager' }, randomUUID()),
      /受保护/,
    );
  } finally {
    f.clean();
  }
});
test('unknown NPM version blocks writes', async () => {
  const f = fixture();
  try {
    f.npm.versionText = '9.0.0';
    await assert.rejects(async () => f.manager.save(input, randomUUID()), /兼容性/);
    assert.equal(f.npm.rows.length, 0);
  } finally {
    f.clean();
  }
});
test('encryption is authenticated and persistent; plaintext not in database', () => {
  const f = fixture();
  try {
    const text = 'private-test-value';
    const encrypted = f.store.seal(text);
    f.store.set('secret', encrypted);
    assert.equal(f.store.secret(), text);
    assert.ok(!encrypted.includes(text));
    const bytes = Buffer.from(encrypted, 'base64');
    bytes[15] ^= 1;
    assert.throws(() => f.store.unseal(bytes.toString('base64')));
  } finally {
    f.clean();
  }
});
test('authentication, origin enforcement, CSRF, and sanitized errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdm-auth-')),
    key = join(dir, 'key');
  writeFileSync(key, randomBytes(32).toString('hex'));
  const { app } = await buildApp(
    {
      dataFile: join(dir, 'a.sqlite'),
      keyFile: key,
      bootstrapToken: 'test-bootstrap',
      origin: 'http://localhost:3100',
      dockerEndpoint: 'unix:///missing',
    },
    { npm: new FakeNpm(), docker: { services: async () => [] } },
  );
  try {
    assert.equal((await app.inject({ url: '/api/entries' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { password: 'long-test-password', bootstrapToken: 'test-bootstrap' },
          headers: { origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { password: 'long-test-password', bootstrapToken: 'test-bootstrap' },
      headers: { origin: 'http://localhost:3100' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'] as string;
    const headers = { cookie: cookie.split(';')[0], origin: 'http://localhost:3100' };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          payload: {},
          headers: { ...headers, 'x-csrf-token': login.json().csrf },
        })
      ).statusCode,
      200,
    );
    assert.equal((await app.inject({ url: '/api/settings', headers })).statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recreated Compose service resolves by identity, requires current published port', async () => {
  const f = fixture();
  try {
    let containerId = 'old';
    const manager = new Manager(f.store, () => f.npm, {
      services: async () => [
        {
          id: containerId,
          name: 'app',
          project: 'photos',
          service: 'web',
          state: 'exited',
          ports: [
            {
              hostPort: 18080,
              containerPort: 3000,
              protocol: 'tcp',
              hostIp: '0.0.0.0',
              eligible: true,
            },
          ],
        },
      ],
    });
    const i = { ...input, project: 'photos', service: 'web', containerPort: 3000 };
    await manager.save(i, randomUUID());
    containerId = 'replacement';
    const result = await manager.save(
      { ...i, websocket: false },
      randomUUID(),
      1,
      fingerprint(await f.npm.get(1)),
    );
    assert.equal(result.status, 'applied');
    assert.equal(f.store.binding(1)?.service, 'web');
    await assert.rejects(
      async () =>
        manager.save({ ...i, port: 3000 }, randomUUID(), 1, fingerprint(await f.npm.get(1))),
      /映射端口/,
    );
  } finally {
    f.clean();
  }
});

test('interrupted operations persist across Store reopen and reconcile safely', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    f.npm.lost = true;
    const key = randomUUID();
    await f.manager.save(input, key);
    f.store.close();
    reopened = new Store(join(f.dir, 'test.sqlite'), f.key);
    const manager = new Manager(reopened, () => f.npm, { services: async () => [] });
    await manager.reconcile();
    assert.equal(reopened.byKey(key)?.status, 'applied');
    assert.equal(reopened.binding(1)?.npmId, 1);
    assert.equal(f.npm.rows.length, 1);
  } finally {
    if (reopened) reopened.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
