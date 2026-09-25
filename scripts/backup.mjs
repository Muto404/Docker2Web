import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
const dest = `backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dest, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(process.env.DATA_FILE || 'data/pdm.sqlite', { readOnly: true });
await backup(db, `${dest}/pdm.sqlite`);
db.close();
writeFileSync(
  `${dest}/RESTORE.txt`,
  'Stop app before restore. Copy pdm.sqlite to data/pdm.sqlite. Remove stale data/pdm.sqlite-wal and data/pdm.sqlite-shm only while stopped. Restore matching secrets/encryption-key separately. Never publish backups. See docs/OPERATIONS.md.\n',
  { mode: 0o600 },
);
console.log(
  `已生成一致性数据库备份：${dest}/pdm.sqlite。请另行安全保存对应 secrets/encryption-key。`,
);
