import Database from 'better-sqlite3';

export interface MemoryEntry {
  key: string;
  value: string;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
  }

  set(key: string, value: string, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null;
    this.db
      .prepare('INSERT OR REPLACE INTO memory (key, value, expires_at) VALUES (?, ?, ?)')
      .run(key, value, expiresAt);
  }

  get(key: string): string | null {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare('SELECT value, expires_at FROM memory WHERE key = ?')
      .get(key) as { value: string; expires_at: number | null } | undefined;

    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) {
      this.delete(key);
      return null;
    }
    return row.value;
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM memory WHERE key = ?').run(key);
  }

  search(query: string): MemoryEntry[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .prepare(
        `SELECT key, value FROM memory
         WHERE key LIKE ?
         AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(`${query}%`, now) as MemoryEntry[];
  }

  getAll(): MemoryEntry[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .prepare(
        `SELECT key, value FROM memory
         WHERE expires_at IS NULL OR expires_at > ?`,
      )
      .all(now) as MemoryEntry[];
  }

  close(): void {
    this.db.close();
  }
}
