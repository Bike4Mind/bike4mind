import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  stableSubscriptionKey,
  updateSingleQueryDataFast,
  setOptimisticQueryData,
  OPTIMISTIC_KEY,
} from './react-query';

describe('stableSubscriptionKey', () => {
  it('produces identical keys for distinct-but-equal query objects', () => {
    // Two separate object instances with the same contents - the exact churn
    // case where a caller passes a fresh inline `{ isChunk: false }` each render.
    const a = stableSubscriptionKey({ isChunk: false });
    const b = stableSubscriptionKey({ isChunk: false });
    expect(a).toBe(b);
  });

  it('is insensitive to key ordering', () => {
    expect(stableSubscriptionKey({ a: 1, b: 2 })).toBe(stableSubscriptionKey({ b: 2, a: 1 }));
  });

  it('serializes nested mongo operators stably', () => {
    expect(stableSubscriptionKey({ age: { $gt: 18 } })).toBe(stableSubscriptionKey({ age: { $gt: 18 } }));
    // nested operator key order must not matter either
    expect(stableSubscriptionKey({ x: { $gt: 1, $lt: 9 } })).toBe(stableSubscriptionKey({ x: { $lt: 9, $gt: 1 } }));
  });

  it('serializes array values ($in) stably and order-sensitively within the array', () => {
    expect(stableSubscriptionKey({ id: { $in: ['a', 'b'] } })).toBe(stableSubscriptionKey({ id: { $in: ['a', 'b'] } }));
    // arrays are ordered data - different order is a different logical query
    expect(stableSubscriptionKey({ id: { $in: ['a', 'b'] } })).not.toBe(
      stableSubscriptionKey({ id: { $in: ['b', 'a'] } })
    );
  });

  it('distinguishes different queries', () => {
    expect(stableSubscriptionKey({ _id: '1' })).not.toBe(stableSubscriptionKey({ _id: '2' }));
    expect(stableSubscriptionKey({ isChunk: false })).not.toBe(stableSubscriptionKey({ isChunk: true }));
  });

  it('serializes Date values by value, not as empty objects', () => {
    // QueryableType permits Date - without special-casing, both collapse to {} and a
    // real query change (different date) would be silently missed.
    const a = stableSubscriptionKey({ createdAt: { $gt: new Date('2020-01-01') } });
    const b = stableSubscriptionKey({ createdAt: { $gt: new Date('2021-01-01') } });
    expect(a).not.toBe(b);
    // identical dates still collapse to one key
    expect(stableSubscriptionKey({ createdAt: { $gt: new Date('2020-01-01') } })).toBe(a);
  });

  it('serializes RegExp values by value, not as empty objects', () => {
    expect(stableSubscriptionKey({ name: { $regex: /foo/i } })).not.toBe(
      stableSubscriptionKey({ name: { $regex: /bar/i } })
    );
  });

  it('gives null and {} distinct, stable keys', () => {
    expect(stableSubscriptionKey(null)).toBe(stableSubscriptionKey(null));
    expect(stableSubscriptionKey({})).toBe(stableSubscriptionKey({}));
    // a null query means "do not subscribe" - it must not collide with an empty match-all query
    expect(stableSubscriptionKey(null)).not.toBe(stableSubscriptionKey({}));
  });
});

// The reconciler is last-write-wins by `updatedAt`, but optimistic patches stamp a
// CLIENT clock. When that clock runs ahead of the server's, the authoritative server
// document was silently dropped. An authoritative document must supersede an optimistic
// placeholder regardless of timestamp, while server-vs-server LWW is kept.
describe('updateSingleQueryDataFast optimistic supersede', () => {
  const CLIENT_CLOCK_AHEAD = new Date('2100-01-01T00:00:00.000Z');
  const SERVER_CLOCK_BEHIND = new Date('2020-01-01T00:00:00.000Z');

  type Row = {
    id: string;
    updatedAt: Date;
    replies?: string[];
    title?: string;
    creditsUsed?: number;
    [OPTIMISTIC_KEY]?: true;
  };

  const optimisticRow = (id: string, overrides: Partial<Row> = {}): Row => ({
    id,
    updatedAt: CLIENT_CLOCK_AHEAD,
    replies: [],
    [OPTIMISTIC_KEY]: true,
    ...overrides,
  });

  const serverRow = (id: string, overrides: Partial<Row> = {}): Row => ({
    id,
    updatedAt: SERVER_CLOCK_BEHIND,
    ...overrides,
  });

  it('applies a server doc over an optimistic entry when the client clock is ahead (data shape)', () => {
    const qc = new QueryClient();
    const key = ['sessions', 'list'];
    qc.setQueryData(key, { data: [optimisticRow('s1')], meta: {} });

    updateSingleQueryDataFast(qc, key, 'write', serverRow('s1', { title: 'from server' }), {
      keysAllowedToCreate: [],
    });

    const entry = (qc.getQueryData(key) as { data: Row[] }).data[0];
    expect(entry.title).toBe('from server');
    expect(entry[OPTIMISTIC_KEY]).toBeUndefined();
  });

  it('same, paged shape', () => {
    const qc = new QueryClient();
    const key = ['quests', 'session', 's1'];
    qc.setQueryData(key, { pages: [{ data: [optimisticRow('q1')] }], pageParams: [{ page: 1 }] });

    updateSingleQueryDataFast(qc, key, 'write', serverRow('q1', { title: 'from server' }), {
      keysAllowedToCreate: [],
    });

    const entry = (qc.getQueryData(key) as { pages: { data: Row[] }[] }).pages[0].data[0];
    expect(entry.title).toBe('from server');
    expect(entry[OPTIMISTIC_KEY]).toBeUndefined();
  });

  it('same, array shape', () => {
    const qc = new QueryClient();
    const key = ['sessions', 'list'];
    qc.setQueryData(key, [optimisticRow('s1')]);

    updateSingleQueryDataFast(qc, key, 'write', serverRow('s1', { title: 'from server' }), {
      keysAllowedToCreate: [],
    });

    const entry = (qc.getQueryData(key) as Row[])[0];
    expect(entry.title).toBe('from server');
    expect(entry[OPTIMISTIC_KEY]).toBeUndefined();
  });

  it('same, single-object shape', () => {
    const qc = new QueryClient();
    const key = ['adminsettings', 's1'];
    qc.setQueryData(key, optimisticRow('s1'));

    updateSingleQueryDataFast(qc, key, 'write', serverRow('s1', { title: 'from server' }), {
      keysAllowedToCreate: [],
    });

    const entry = qc.getQueryData(key) as Row;
    expect(entry.title).toBe('from server');
    expect(entry[OPTIMISTIC_KEY]).toBeUndefined();
  });

  it('still rejects a stale server-vs-server update (LWW unchanged)', () => {
    const qc = new QueryClient();
    const key = ['sessions', 'list'];
    qc.setQueryData(key, {
      data: [serverRow('s1', { updatedAt: new Date('2030-01-01T00:00:00.000Z'), title: 'newer' })],
      meta: {},
    });

    updateSingleQueryDataFast(qc, key, 'write', serverRow('s1', { title: 'stale' }), {
      keysAllowedToCreate: [],
    });

    const entry = (qc.getQueryData(key) as { data: Row[] }).data[0];
    expect(entry.title).toBe('newer');
    expect(entry.updatedAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });

  it('keeps the timestamp rule for optimistic-vs-optimistic (older patch rejected)', () => {
    const qc = new QueryClient();
    const key = ['sessions', 'list'];
    qc.setQueryData(key, {
      data: [optimisticRow('s1', { updatedAt: new Date('2030-01-01T00:00:00.000Z'), title: 'newer' })],
      meta: {},
    });

    updateSingleQueryDataFast(
      qc,
      key,
      'write',
      optimisticRow('s1', { updatedAt: SERVER_CLOCK_BEHIND, title: 'older' }),
      { keysAllowedToCreate: [] }
    );

    const entry = (qc.getQueryData(key) as { data: Row[] }).data[0];
    expect(entry.title).toBe('newer');
    expect(entry[OPTIMISTIC_KEY]).toBe(true);
  });

  it('setOptimisticQueryData marks the entry, and a later server doc clears it (regression)', async () => {
    const qc = new QueryClient();
    const key = ['quests', 'session', 's1'];
    await setOptimisticQueryData(qc, key, { id: 'q1', updatedAt: CLIENT_CLOCK_AHEAD });

    const seeded = (qc.getQueryData(key) as { pages: { data: Row[] }[] }).pages[0].data[0];
    expect(seeded[OPTIMISTIC_KEY]).toBe(true);

    updateSingleQueryDataFast(qc, key, 'write', serverRow('q1', { creditsUsed: 42 }), {
      keysAllowedToCreate: [],
    });

    const entry = (qc.getQueryData(key) as { pages: { data: Row[] }[] }).pages[0].data[0];
    expect(entry.creditsUsed).toBe(42);
    expect(entry[OPTIMISTIC_KEY]).toBeUndefined();
  });
});
