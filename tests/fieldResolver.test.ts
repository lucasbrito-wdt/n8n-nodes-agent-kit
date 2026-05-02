import { resolveField } from '../utils/fieldResolver';

const obj = {
  message: 'hello',
  msg: { content: 'nested value' },
  data: [{ text: 'item0' }, { text: 'item1' }],
  deep: { a: { b: { c: 'deepest' } } },
  'key.with.dots': 'literal dot key',
  arr: ['zero', 'one'],
};

describe('resolveField', () => {
  it('resolves simple top-level key', () => {
    expect(resolveField(obj, 'message')).toBe('hello');
  });

  it('resolves dot notation', () => {
    expect(resolveField(obj, 'msg.content')).toBe('nested value');
  });

  it('resolves deep dot notation', () => {
    expect(resolveField(obj, 'deep.a.b.c')).toBe('deepest');
  });

  it('resolves array index', () => {
    expect(resolveField(obj, 'arr[0]')).toBe('zero');
    expect(resolveField(obj, 'arr[1]')).toBe('one');
  });

  it('resolves array of objects with dot', () => {
    expect(resolveField(obj, 'data[0].text')).toBe('item0');
    expect(resolveField(obj, 'data[1].text')).toBe('item1');
  });

  it('resolves double-quoted bracket notation', () => {
    expect(resolveField(obj, 'msg["content"]')).toBe('nested value');
  });

  it('resolves single-quoted bracket notation', () => {
    expect(resolveField(obj, "msg['content']")).toBe('nested value');
  });

  it('resolves mixed bracket and dot notation', () => {
    expect(resolveField(obj, 'data[0]["text"]')).toBe('item0');
  });

  it('returns undefined for missing keys', () => {
    expect(resolveField(obj, 'nonexistent')).toBeUndefined();
    expect(resolveField(obj, 'msg.nope')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    expect(resolveField(obj, '')).toBeUndefined();
  });

  it('treats resolved message text as literal value (fallback)', () => {
    expect(resolveField(obj, 'Oi, Tudo bem?')).toBe('Oi, Tudo bem?');
    expect(resolveField(obj, 'Hello! How are you?')).toBe('Hello! How are you?');
  });

  it('handles null/undefined mid-path gracefully', () => {
    expect(resolveField(null, 'message')).toBeUndefined();
    expect(resolveField(obj, 'message.deep')).toBeUndefined();
  });
});
