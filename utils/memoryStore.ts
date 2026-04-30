import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface MemoryEntry {
  key: string;
  value: string;
}

interface StoreEntry {
  value: string;
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// JSON-file fallback — zero native deps, survives container restarts
// ---------------------------------------------------------------------------

class JsonFileStore {
  private data = new Map<string, StoreEntry>();
  private filePath: string;

  constructor(dbPath: string) {
    this.filePath = dbPath.replace(/\.db$/, '.json');
    mkdirSync(dirname(this.filePath), { recursive: true });
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, StoreEntry>;
      this.data = new Map(Object.entries(parsed));
    } catch {
      // first run — start empty
    }
  }

  private persist(): void {
    const obj: Record<string, StoreEntry> = {};
    for (const [k, v] of this.data) obj[k] = v;
    writeFileSync(this.filePath, JSON.stringify(obj));
  }

  set(key: string, value: string, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null;
    this.data.set(key, { value, expiresAt });
    this.persist();
  }

  get(key: string): string | null {
    const now = Math.floor(Date.now() / 1000);
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.data.delete(key);
      this.persist();
      return null;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.data.delete(key);
    this.persist();
  }

  search(query: string): MemoryEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const results: MemoryEntry[] = [];
    for (const [key, entry] of this.data) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      if (!key.startsWith(query)) continue;
      results.push({ key, value: entry.value });
    }
    return results;
  }

  getAll(): MemoryEntry[] {
    const now = Math.floor(Date.now() / 1000);
    const results: MemoryEntry[] = [];
    for (const [key, entry] of this.data) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      results.push({ key, value: entry.value });
    }
    return results;
  }

  close(): void {
    this.persist();
  }
}

// ---------------------------------------------------------------------------
// SQLite backend — used when better-sqlite3 native bindings are available
// ---------------------------------------------------------------------------

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): void;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
}

class SqliteStore {
  private db: SqliteDb;

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new Database(dbPath) as unknown as SqliteDb;
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
      .prepare(`SELECT key, value FROM memory WHERE expires_at IS NULL OR expires_at > ?`)
      .all(now) as MemoryEntry[];
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Public facade — picks SQLite when available, JSON file otherwise
// ---------------------------------------------------------------------------

type Backend = SqliteStore | JsonFileStore;

export class MemoryStore {
  private backend: Backend;
  private readonly usingFallback: boolean;

  constructor(dbPath: string) {
    try {
      this.backend = new SqliteStore(dbPath);
      this.usingFallback = false;
    } catch {
      this.backend = new JsonFileStore(dbPath);
      this.usingFallback = true;
    }
  }

  get isFallback(): boolean {
    return this.usingFallback;
  }

  set(key: string, value: string, ttlSeconds?: number): void {
    this.backend.set(key, value, ttlSeconds);
  }

  get(key: string): string | null {
    return this.backend.get(key);
  }

  delete(key: string): void {
    this.backend.delete(key);
  }

  search(query: string): MemoryEntry[] {
    return this.backend.search(query);
  }

  getAll(): MemoryEntry[] {
    return this.backend.getAll();
  }

  close(): void {
    this.backend.close();
  }
}
