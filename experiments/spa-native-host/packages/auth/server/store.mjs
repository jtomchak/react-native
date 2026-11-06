import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import path from 'node:path';

// Single-host prototype persistence. Shared/serverless deployments need an
// equivalent transactional store, not a copy of this file per instance.
export class AuthStore {
  constructor(file, {now = Date.now} = {}) {
    if (!path.isAbsolute(file) || file === ':memory:') throw new Error('An absolute durable auth database path is required');
    mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, expires REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS expiry ON records(expires)');
    this.now = now;
  }
  atomic(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=? AND expires>?').get(kind, id, this.now());
    return row ? JSON.parse(row.data) : null;
  }
  put(kind, id, value, expires) {
    this.db.prepare('DELETE FROM records WHERE expires<=?').run(this.now());
    if (this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n >= 50000) throw new Error('Auth store capacity reached');
    this.db.prepare('INSERT INTO records(kind,id,expires,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET expires=excluded.expires,data=excluded.data').run(kind, id, expires, JSON.stringify(value));
  }
  remove(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? AND expires>?').all(kind, this.now()).map(row => JSON.parse(row.data)); }
  close() { this.db.close(); }
}
