import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('.runtime', { recursive: true, mode: 0o700 });
let p = spawnSync('docker', ['compose', '-f', 'compose.integration.yaml', 'up', '-d'], {
  stdio: 'inherit',
});
if (p.status) process.exit(p.status);
const base = 'http://127.0.0.1:18181/api';
let info;
for (let i = 0; i < 45; i++) {
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(2000) });
    info = await r.json();
    if (info.status === 'OK') break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!info) throw Error('测试 NPM 尚未就绪，请查看隔离容器日志');
if (!info.setup) {
  const creds = { identity: 'pdm-test@example.com', secret: randomBytes(32).toString('hex') };
  const r = await fetch(base + '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'PDM Test',
      nickname: 'PDM',
      email: creds.identity,
      auth: { type: 'password', secret: creds.secret },
    }),
  });
  if (!r.ok) throw Error('测试账号初始化失败');
  writeFileSync('.runtime/npm-credentials.json', JSON.stringify(creds), { mode: 0o600 });
} else if (!existsSync('.runtime/npm-credentials.json'))
  throw Error('测试实例已初始化但凭据文件缺失；请明确清理隔离测试卷后再试，不能使用正式实例');
p = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    '.runtime/test.key',
    '-out',
    '.runtime/test.crt',
    '-days',
    '2',
    '-subj',
    '/CN=*.pdm.example.test',
    '-addext',
    'subjectAltName=DNS:*.pdm.example.test',
  ],
  { stdio: 'ignore' },
);
if (p.status) throw Error('测试证书生成失败');
console.log(
  '隔离 NPM 与测试凭据已就绪。使用 NODE_EXTRA_CA_CERTS=.runtime/test.crt npm run test:integration',
);
