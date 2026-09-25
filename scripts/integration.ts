/** Integration against an isolated NPM. Refuses the production port (81). */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Npm } from '../src/server/npm.js';
import { buildApp } from '../src/server/app.js';
import type { Entry, Operation } from '../src/shared/types.js';
const url = process.env.TEST_NPM_URL || 'http://127.0.0.1:18181';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || new URL(url).port !== '18181')
  throw new Error('Only isolated localhost:18181 is allowed');
const creds = JSON.parse(
  readFileSync(process.env.TEST_CREDENTIALS_FILE || '.runtime/npm-credentials.json', 'utf8'),
) as { identity: string; secret: string };
const login = await fetch(url + '/api/tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(creds),
});
assert.equal(login.status, 200);
const { token } = (await login.json()) as { token: string };
async function raw(path: string, body: unknown, method = 'POST') {
  const r = await fetch(url + '/api' + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`NPM ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as Record<string, unknown>;
}
const npm = new Npm(url, creds.identity, creds.secret);
assert.equal(await npm.version(), '2.16.0');
let cert = (await npm.certificates()).find((c) => c.nice_name === 'PDM isolated integration');
const certificateId =
  cert?.id ||
  (await raw('/nginx/certificates', { provider: 'other', nice_name: 'PDM isolated integration' }))
    .id;
const form = new FormData();
form.set('certificate', new Blob([readFileSync('.runtime/test.crt')]), 'test.crt');
form.set('certificate_key', new Blob([readFileSync('.runtime/test.key')]), 'test.key');
await raw(`/nginx/certificates/${certificateId}/upload`, form);
cert = (await npm.certificates()).find((c) => c.id === certificateId)!;
assert.ok(cert?.domain_names.includes('*.pdm.example.test'));
mkdirSync('.runtime/integration', { recursive: true });
const keyFile = '.runtime/integration/key';
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const upstream = createServer((_req, res) =>
  res.writeHead(200, { 'content-type': 'text/plain' }).end('pdm-integration-ok'),
);
await new Promise<void>((r) => upstream.listen(18999, '0.0.0.0', r));
const { app, store } = await buildApp({
  dataFile: '.runtime/integration/pdm.sqlite',
  keyFile,
  bootstrapToken: 'integration-bootstrap-only',
  origin: 'http://127.0.0.1:13100',
  dockerEndpoint: `unix://${process.env.HOME}/.docker/run/docker.sock`,
});
let cookie = '',
  csrf = '';
async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method?: string,
  expected = 200,
): Promise<T> {
  const r = await app.inject({
    url: '/api' + path,
    method: (method || (body ? 'POST' : 'GET')) as 'GET' | 'POST' | 'PUT',
    headers: { origin: 'http://127.0.0.1:13100', cookie, 'x-csrf-token': csrf },
    ...(body ? { payload: body } : {}),
  });
  assert.equal(r.statusCode, expected, `${path}: ${r.body}`);
  if (r.headers['set-cookie']) cookie = String(r.headers['set-cookie']).split(';')[0];
  const d = r.json();
  if (d.csrf) csrf = d.csrf;
  return d as T;
}
try {
  const auth = await call<{ initialized: boolean }>('/auth/status');
  await call(auth.initialized ? '/auth/login' : '/auth/setup', {
    password: 'Isolated-test-password-2026',
    bootstrapToken: 'integration-bootstrap-only',
  });
  await call(
    '/settings',
    {
      npmUrl: url,
      identity: creds.identity,
      secret: creds.secret,
      baseDomain: 'pdm.example.test',
      forwardHost: 'host.docker.internal',
      certificateId: cert.id,
      proxyHost: '127.0.0.1',
      proxyPort: 18443,
      expectedIp: '',
      protectedDomains: [],
    },
    'PUT',
  );
  const services = await call<unknown[]>('/services');
  assert.ok(services.length > 0);
  console.log('PASS: real Docker discovery');
  const before = (await npm.hosts()).length;
  const subdomain = 'test-' + Date.now().toString(36),
    input = {
      subdomain,
      port: 18999,
      scheme: 'http',
      certificateId: cert.id,
      websocket: true,
      project: '',
      service: '',
      containerPort: null,
    };
  const key = randomUUID();
  const created = await call<Operation>('/entries', { key, input });
  assert.equal(created.status, 'applied', created.error || '');
  assert.ok(created.npmId);
  const id = created.npmId!;
  await call('/entries', { key, input });
  assert.equal((await npm.hosts()).length, before + 1);
  console.log('PASS: real NPM create, certificate binding, idempotency');
  const entries = () => call<Entry[]>('/entries');
  let h = (await entries()).find((e) => e.id === id)!;
  const check = await call<{
    tls: { ok: boolean; message: string };
    http: { ok: boolean; message: string };
  }>(`/entries/${id}/check`, {});
  assert.equal(check.tls.ok, true, check.tls.message);
  assert.equal(check.http.ok, true, check.http.message);
  console.log('PASS: trusted TLS + NPM → host.docker.internal → upstream HTTP 200');
  const edited = await call<Operation>(
    `/entries/${id}`,
    { key: randomUUID(), fingerprint: h.fingerprint, input: { ...input, websocket: false } },
    'PUT',
  );
  assert.equal(edited.status, 'applied');
  await call(
    `/entries/${id}`,
    { key: randomUUID(), fingerprint: h.fingerprint, input },
    'PUT',
    409,
  );
  console.log('PASS: real update + stale fingerprint rejected');
  h = (await entries()).find((e) => e.id === id)!;
  await call(`/operations/${edited.id}/rollback`, {
    key: randomUUID(),
    fingerprint: h.fingerprint,
  });
  assert.equal((await npm.get(id)).allow_websocket_upgrade, true);
  console.log('PASS: rollback');
  h = (await entries()).find((e) => e.id === id)!;
  await call(`/entries/${id}/action`, {
    key: randomUUID(),
    fingerprint: h.fingerprint,
    action: 'archive',
  });
  assert.equal((await npm.get(id)).enabled, false);
  h = (await entries()).find((e) => e.id === id)!;
  assert.equal(h.binding?.archived, true);
  await call(`/entries/${id}/action`, {
    key: randomUUID(),
    fingerprint: h.fingerprint,
    action: 'restore',
  });
  assert.equal((await npm.get(id)).enabled, true);
  console.log('PASS: archive + restore');
  // Test rule is left disabled for reproducible inspection, never touches production NPM.
  h = (await entries()).find((e) => e.id === id)!;
  await call(`/entries/${id}/action`, {
    key: randomUUID(),
    fingerprint: h.fingerprint,
    action: 'archive',
  });
  assert.ok(!JSON.stringify(await call('/certificates')).includes('certificate_key'));
  assert.ok(!JSON.stringify(await call('/settings')).includes(creds.secret));
  console.log('PASS: API secrets redacted');
  const s = store.settings();
  assert.ok(s);
  console.log('INTEGRATION PASSED');
} finally {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
}
