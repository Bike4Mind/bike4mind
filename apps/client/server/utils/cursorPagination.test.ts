import { describe, expect, it } from 'vitest';
import { decodeCursor, decodeTimeIdCursor, encodeCursor, encodeTimeIdCursor, paginateById } from './cursorPagination';

const items = ['c', 'a', 'e', 'b', 'd'].map(id => ({ id }));

describe('cursorPagination', () => {
  it('round-trips a cursor for the same scope', () => {
    expect(decodeCursor(encodeCursor('lakes', 'abc'), 'lakes')).toBe('abc');
  });

  it('encodes a url-safe, versioned payload', () => {
    const cursor = encodeCursor('lakes', 'abc');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({ v: 1, s: 'lakes', after: 'abc' });
  });

  it('rejects a cursor issued for another scope with a 422', () => {
    expect(() => decodeCursor(encodeCursor('other', 'abc'), 'lakes')).toThrow(
      expect.objectContaining({ statusCode: 422 })
    );
  });

  it('rejects garbage, non-JSON and wrong-version cursors with a 422', () => {
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, s: 'lakes', after: 'a' })).toString('base64url');
    const wrongShape = Buffer.from(JSON.stringify({ v: 1, s: 'lakes', after: 123 })).toString('base64url');
    for (const bad of ['!!!', Buffer.from('not json').toString('base64url'), wrongVersion, wrongShape]) {
      expect(() => decodeCursor(bad, 'lakes')).toThrow(expect.objectContaining({ statusCode: 422 }));
    }
  });

  it('pages through every item in id order and ends with a null cursor', () => {
    const first = paginateById(items, { limit: 2, scope: 'lakes' });
    expect(first.items.map(i => i.id)).toEqual(['a', 'b']);
    expect(first.nextCursor).not.toBeNull();

    const second = paginateById(items, { limit: 2, scope: 'lakes', cursor: first.nextCursor! });
    expect(second.items.map(i => i.id)).toEqual(['c', 'd']);

    const last = paginateById(items, { limit: 2, scope: 'lakes', cursor: second.nextCursor! });
    expect(last.items.map(i => i.id)).toEqual(['e']);
    expect(last.nextCursor).toBeNull();
  });

  it('keeps a cursor valid when the caller changes limit mid-pagination', () => {
    const first = paginateById(items, { limit: 1, scope: 'lakes' });
    const rest = paginateById(items, { limit: 3, scope: 'lakes', cursor: first.nextCursor! });
    expect(rest.items.map(i => i.id)).toEqual(['b', 'c', 'd']);
    expect(rest.nextCursor).not.toBeNull();
  });

  it('returns a null cursor when the page exactly exhausts the items', () => {
    expect(paginateById(items, { limit: 5, scope: 'lakes' }).nextCursor).toBeNull();
  });

  it('resumes after the cursor id even if that item has since disappeared', () => {
    const cursor = encodeCursor('lakes', 'b');
    const page = paginateById(
      items.filter(i => i.id !== 'b'),
      { limit: 10, scope: 'lakes', cursor }
    );
    expect(page.items.map(i => i.id)).toEqual(['c', 'd', 'e']);
  });

  it('does not mutate the input array', () => {
    const input = [...items];
    paginateById(input, { limit: 2, scope: 'lakes' });
    expect(input.map(i => i.id)).toEqual(['c', 'a', 'e', 'b', 'd']);
  });
});

describe('time-id cursors', () => {
  const at = new Date('2026-02-03T04:05:06.007Z');
  const id = '65a000000000000000000001';

  it('round-trips a timestamp and ObjectId for the same scope', () => {
    const decoded = decodeTimeIdCursor(encodeTimeIdCursor('feed', { at, id }), 'feed');
    expect(decoded).toEqual({ at, id });
  });

  it.each([
    ['another scope', encodeTimeIdCursor('other', { at, id })],
    ['no separator', encodeCursor('feed', id)],
    ['a non-ObjectId id', encodeCursor('feed', `${at.toISOString()}|abc`)],
    ['an invalid timestamp', encodeCursor('feed', `nope|${id}`)],
    ['a non-canonical timestamp', encodeCursor('feed', `2026-02-03|${id}`)],
    ['extra segments', encodeCursor('feed', `${at.toISOString()}|${id}|x`)],
  ])('rejects %s with a 422', (_label, cursor) => {
    expect(() => decodeTimeIdCursor(cursor, 'feed')).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});
