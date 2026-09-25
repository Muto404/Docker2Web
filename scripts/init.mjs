import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('secrets', { recursive: true, mode: 0o700 });
mkdirSync('data', { recursive: true, mode: 0o700 });
for (const name of ['encryption-key', 'bootstrap-token'])
  if (!existsSync(`secrets/${name}`))
    writeFileSync(`secrets/${name}`, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
console.log(
  '初始化文件已就绪。首次打开网页时，在本机读取 secrets/bootstrap-token 并填写。请妥善备份 secrets/encryption-key，勿提交到 Git。',
);
