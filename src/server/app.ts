import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import statics from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { Npm, type NpmPort } from './npm.js';
import { Docker } from './docker.js';
import { Manager } from './manager.js';
import { AppError, inputSchema, settingsSchema } from './domain.js';
import { checkHost } from './checks.js';
import type { Settings } from '../shared/types.js';
export interface Config {
  dataFile: string;
  keyFile: string;
  bootstrapToken: string;
  origin: string;
  dockerEndpoint: string;
  webRoot?: string;
}
export async function buildApp(
  c: Config,
  provided?: { npm?: NpmPort; docker?: Pick<Docker, 'services'> },
) {
  const app = Fastify({ logger: false, bodyLimit: 32768, trustProxy: false });
  const store = new Store(c.dataFile, c.keyFile);
  let cached: Npm | null = null;
  const client = () => {
    if (provided?.npm) return provided.npm;
    const s = store.settings();
    if (!s) throw new AppError(400, '请先保存 NPM 连接设置');
    if (!cached) cached = new Npm(s.npmUrl, s.identity, store.secret());
    return cached;
  };
  const docker = provided?.docker || new Docker(c.dockerEndpoint);
  const manager = new Manager(store, client, docker, new URL(c.origin).hostname);
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.setErrorHandler((e, _req, res) => {
    if (e instanceof ZodError)
      return res.status(400).send({ error: e.issues.map((i) => i.message).join('；') });
    if (e instanceof AppError) return res.status(e.status).send({ error: e.message });
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 429) return res.status(429).send({ error: '请求过于频繁，请稍后重试' });
    return res
      .status(code && code >= 400 && code < 500 ? code : 500)
      .send({ error: '操作失败，请检查输入或服务连接' });
  });
  function session(token?: string) {
    if (!token) return null;
    store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    return store.db
      .prepare('SELECT csrf,expires FROM sessions WHERE token=?')
      .get(createHash('sha256').update(token).digest('hex')) as
      { csrf: string; expires: number } | undefined;
  }
  app.addHook('onRequest', async (req, res) => {
    const path = req.url.split('?')[0];
    if (
      path.includes('%') ||
      path.includes('\\') ||
      path.includes('//') ||
      path.split('/').some((p) => p === '.' || p === '..')
    )
      throw new AppError(400, '请求路径无效');
    res
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (!req.url.startsWith('/api/')) return;
    res.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin !== c.origin) throw new AppError(403, '请求来源不匹配');
      if (!String(req.headers['content-type'] || '').startsWith('application/json'))
        throw new AppError(415, '需要 JSON 请求');
    }
    if (['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login'].includes(req.url))
      return;
    const s = session(req.cookies.pdm_session);
    if (!s) throw new AppError(401, '请先登录');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== s.csrf)
      throw new AppError(403, '会话校验失败，请刷新页面');
  });
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  app.get('/api/auth/status', async (req) => {
    const s = session(req.cookies.pdm_session);
    return {
      initialized: !!store.get('admin'),
      authenticated: !!s,
      csrf: s?.csrf || '',
      configured: !!s && !!store.settings(),
    };
  });
  const loginSchema = z.object({
    password: z.string().min(12, '密码至少 12 位').max(200),
    bootstrapToken: z.string().optional(),
  });
  const establish = (res: {
    setCookie: (name: string, value: string, opts: Record<string, unknown>) => unknown;
  }) => {
    const token = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    store.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), csrf, Date.now() + 12 * 3600_000);
    res.setCookie('pdm_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: c.origin.startsWith('https:'),
      maxAge: 12 * 3600,
    });
    return { csrf };
  };
  app.post(
    '/api/auth/setup',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, res) => {
      const b = loginSchema.parse(req.body);
      if (store.get('admin')) throw new AppError(409, '管理员已初始化');
      const expected = Buffer.from(c.bootstrapToken),
        given = Buffer.from(b.bootstrapToken || '');
      if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected))
        throw new AppError(403, '初始化密钥不正确，请查看本地 secrets/bootstrap-token');
      const salt = randomBytes(16).toString('hex');
      store.set('admin', { salt, hash: scryptSync(b.password, salt, 64).toString('hex') });
      return establish(res);
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (req, res) => {
      const b = loginSchema.parse(req.body),
        admin = store.get<{ salt: string; hash: string }>('admin');
      if (
        !admin ||
        !timingSafeEqual(scryptSync(b.password, admin.salt, 64), Buffer.from(admin.hash, 'hex'))
      )
        throw new AppError(401, '密码不正确');
      return establish(res);
    },
  );
  app.post('/api/auth/logout', async (req, res) => {
    if (req.cookies.pdm_session)
      store.db
        .prepare('DELETE FROM sessions WHERE token=?')
        .run(createHash('sha256').update(req.cookies.pdm_session).digest('hex'));
    res.clearCookie('pdm_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/settings', async () => ({
    settings: store.settings(),
    hasSecret: !!store.get('secret'),
  }));
  app.put('/api/settings', async (req) =>
    manager.serial.run(async () => {
      const b = settingsSchema.parse(req.body);
      const old = store.settings();
      if (
        old &&
        store.bindings().length &&
        (b.npmUrl !== old.npmUrl ||
          b.baseDomain !== old.baseDomain ||
          b.forwardHost !== old.forwardHost)
      )
        throw new AppError(409, '已有托管规则，v0.1 不支持更换 NPM 实例、基础域名或转发主机');
      const secret = b.secret || store.secret();
      if (!secret) throw new AppError(400, '首次连接需要 NPM 密码');
      const test = provided?.npm || new Npm(b.npmUrl, b.identity, secret);
      const [version, certs] = await Promise.all([test.version(), test.certificates()]);
      if (b.certificateId && !certs.some((x) => x.id === b.certificateId))
        throw new AppError(400, '证书不存在或无权访问');
      const { secret: _secret, ...settings } = b;
      store.set('settings', settings satisfies Settings);
      store.set('secret', store.seal(secret));
      cached = null;
      return { ok: true, version, compatible: version === '2.16.0' };
    }),
  );
  app.get('/api/connection', async () => {
    const [n, d] = await Promise.allSettled([client().version(), docker.services()]);
    return {
      npm:
        n.status === 'fulfilled'
          ? { ok: true, version: n.value, compatible: n.value === '2.16.0' }
          : { ok: false, message: 'NPM 未连接' },
      docker:
        d.status === 'fulfilled'
          ? { ok: true, count: d.value.length }
          : { ok: false, message: 'Docker 未连接' },
    };
  });
  app.get('/api/services', async () => docker.services());
  app.get('/api/certificates', async () => client().certificates());
  app.get('/api/entries', async () => manager.entries());
  app.get('/api/operations', async () =>
    store.operations().map(({ request, before, after, ...o }) => ({
      ...o,
      canRollback: o.action === 'update' && o.status === 'applied' && !!before && !!after,
      domains: after?.domain_names || before?.domain_names || [],
      before: before
        ? {
            domain: before.domain_names.join(', '),
            target: `${before.forward_host}:${before.forward_port}`,
          }
        : null,
      after: after
        ? {
            domain: after.domain_names.join(', '),
            target: `${after.forward_host}:${after.forward_port}`,
          }
        : null,
    })),
  );
  const id = (req: { params: unknown }) =>
    z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;
  const mutation = z.object({ key: z.uuid(), fingerprint: z.string().min(1) });
  app.post('/api/entries', async (req) => {
    const b = z.object({ key: z.uuid(), input: inputSchema }).parse(req.body);
    return manager.save(b.input, b.key);
  });
  app.put('/api/entries/:id', async (req) => {
    const b = mutation.extend({ input: inputSchema }).parse(req.body);
    return manager.save(b.input, b.key, id(req), b.fingerprint);
  });
  app.post('/api/entries/:id/adopt', async (req) => {
    const b = z.object({ fingerprint: z.string() }).parse(req.body);
    return manager.adopt(id(req), b.fingerprint);
  });
  app.post('/api/entries/:id/action', async (req) => {
    const b = mutation
      .extend({ action: z.enum(['enable', 'disable', 'archive', 'restore']) })
      .parse(req.body);
    return manager.change(id(req), b.action, b.key, b.fingerprint);
  });
  app.post('/api/entries/:id/check', async (req) => {
    const h = await client().get(id(req));
    return checkHost(h, manager.settings());
  });
  app.post('/api/operations/reconcile', async () => {
    await manager.reconcile();
    return { ok: true };
  });
  app.post('/api/operations/:id/rollback', async (req) => {
    const op = z.object({ id: z.uuid() }).parse(req.params),
      b = mutation.parse(req.body);
    return manager.rollback(op.id, b.key, b.fingerprint);
  });
  const root = c.webRoot || resolve('dist/web');
  if (existsSync(root)) {
    await app.register(statics, { root });
    app.setNotFoundHandler((req, res) =>
      req.url.startsWith('/api/')
        ? res.status(404).send({ error: '接口不存在' })
        : res.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => store.close());
  return { app, store, manager };
}
