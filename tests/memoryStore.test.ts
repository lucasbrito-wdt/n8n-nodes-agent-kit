import { MemoryStore } from '../utils/memoryStore';
import * as fs from 'fs';

const DB_PATH = '/tmp/test-agentkit.db';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    store = new MemoryStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  });

  it('sets and gets a value', () => {
    store.set('lang', 'PT-BR');
    expect(store.get('lang')).toBe('PT-BR');
  });

  it('returns null for missing key', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('overwrites existing value', () => {
    store.set('key', 'v1');
    store.set('key', 'v2');
    expect(store.get('key')).toBe('v2');
  });

  it('deletes a value', () => {
    store.set('key', 'value');
    store.delete('key');
    expect(store.get('key')).toBeNull();
  });

  it('expires value after TTL', () => {
    jest.useFakeTimers();
    store.set('temp', 'data', 1); // 1 second TTL
    jest.advanceTimersByTime(1500);
    expect(store.get('temp')).toBeNull();
    jest.useRealTimers();
  });

  it('does not expire value before TTL', () => {
    jest.useFakeTimers();
    store.set('temp', 'data', 10); // 10 second TTL
    jest.advanceTimersByTime(5000);
    expect(store.get('temp')).toBe('data');
    jest.useRealTimers();
  });

  it('searches by key prefix', () => {
    store.set('user_lang', 'PT-BR');
    store.set('user_timezone', 'America/Sao_Paulo');
    store.set('project_active', 'jarvis');
    const results = store.search('user_');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key)).toContain('user_lang');
    expect(results.map((r) => r.key)).toContain('user_timezone');
  });

  it('returns all non-expired entries with getAll', () => {
    store.set('a', '1');
    store.set('b', '2');
    const all = store.getAll();
    expect(all).toHaveLength(2);
  });
});
