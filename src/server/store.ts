import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Binding, Operation, Settings } from '../shared/types.js';
export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(path: string, keyFile: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (this.key.length !== 32) throw new Error('密钥文件必须包含 64 位十六进制密钥');
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error('数据库版本较新，请使用匹配的应用版本或恢复备份');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bindings (id INTEGER PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,ikey TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
 PRAGMA user_version=1;`);
  }
  get<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as
      { value: string } | undefined;
    return r ? JSON.parse(r.value) : null;
  }
  set(key: string, v: unknown) {
    this.db
      .prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(v));
  }
  seal(s: string) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]).toString('base64');
  }
  unseal(s: string) {
    const b = Buffer.from(s, 'base64'),
      d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
  }
  settings() {
    return this.get<Settings>('settings');
  }
  secret() {
    const v = this.get<string>('secret');
    return v ? this.unseal(v) : '';
  }
  binding(id: number): Binding | null {
    const r = this.db.prepare('SELECT data FROM bindings WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  bind(b: Binding) {
    this.db
      .prepare('INSERT INTO bindings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(b.npmId, JSON.stringify(b));
  }
  bindings() {
    return (this.db.prepare('SELECT data FROM bindings').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Binding,
    );
  }
  operation(o: Operation) {
    this.db
      .prepare(
        'INSERT INTO operations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(o.id, o.key, JSON.stringify(o));
  }
  operations() {
    return (
      this.db.prepare('SELECT data FROM operations ORDER BY rowid DESC LIMIT 300').all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as Operation);
  }
  pending() {
    return (
      this.db
        .prepare(
          "SELECT data FROM operations WHERE json_extract(data, '$.status') IN ('pending','needs_attention')",
        )
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Operation);
  }
  byKey(key: string) {
    const r = this.db.prepare('SELECT data FROM operations WHERE ikey=?').get(key) as
      { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Operation) : null;
  }
  close() {
    this.db.close();
  }
}
