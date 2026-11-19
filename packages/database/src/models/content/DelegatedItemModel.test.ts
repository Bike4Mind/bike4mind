import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { DelegatedItemModel, delegatedItemRepository, type DelegatedItemInput } from './DelegatedItemModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await DelegatedItemModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await DelegatedItemModel.deleteMany({});
});

const input = (overrides: Partial<DelegatedItemInput> = {}): DelegatedItemInput => ({
  userId: 'user-me',
  intent: 'Summarize for the team',
  url: 'https://example.com/report',
  text: null,
  fileIds: [],
  ...overrides,
});

const t0 = new Date('2026-11-01T00:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const settled = { status: 'handled' as const, result: 'Summarized it.', model: 'test-model' };

async function insertAt(createdAt: Date, overrides: Record<string, unknown> = {}) {
  const [doc] = await DelegatedItemModel.insertMany(
    [{ ...input(), status: 'pending', createdAt, updatedAt: createdAt, ...overrides }],
    { timestamps: false } as Parameters<typeof DelegatedItemModel.insertMany>[1]
  );
  return doc._id.toString();
}

describe('delegatedItemRepository.create and reads', () => {
  it('creates a pending item that only its owner can read', async () => {
    const created = await delegatedItemRepository.create(input({ fileIds: ['f1'] }));
    expect(created).toMatchObject({ status: 'pending', result: null, briefedAt: null, fileIds: ['f1'] });

    const id = created._id.toString();
    expect(await delegatedItemRepository.findByIdForUser(id, 'user-me')).toMatchObject({ intent: input().intent });
    expect(await delegatedItemRepository.findByIdForUser(id, 'user-other')).toBeNull();
    expect(await delegatedItemRepository.findById(id)).toMatchObject({ userId: 'user-me' });
  });

  it('reads a malformed id as missing', async () => {
    expect(await delegatedItemRepository.findById('not-an-id')).toBeNull();
    expect(await delegatedItemRepository.findByIdForUser('not-an-id', 'user-me')).toBeNull();
  });

  it('rejects an intent over the cap', async () => {
    await expect(delegatedItemRepository.create(input({ intent: 'x'.repeat(201) }))).rejects.toThrow(/intent/);
  });
});

describe('delegatedItemRepository settling', () => {
  it('settles a pending item once and never overwrites an outcome', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();

    expect(await delegatedItemRepository.markSettled(id, settled, at(1))).toBe(true);
    expect(await delegatedItemRepository.markFailed(id, 'late', at(2))).toBe(false);
    expect(await delegatedItemRepository.markSettled(id, { ...settled, result: 'again' }, at(3))).toBe(false);

    expect(await delegatedItemRepository.findById(id)).toMatchObject({
      status: 'handled',
      result: 'Summarized it.',
      model: 'test-model',
      settledAt: at(1),
      failureReason: null,
    });
  });

  it('leases a pending item to one delivery at a time until the lease runs out or is released', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();

    expect(await delegatedItemRepository.claim(id, at(0), 100)).toBe(true);
    expect(await delegatedItemRepository.claim(id, at(50), 100)).toBe(false);
    expect(await delegatedItemRepository.claim(id, at(100), 100)).toBe(true);
    await delegatedItemRepository.releaseClaim(id);
    expect((await delegatedItemRepository.findById(id))?.claimedUntil).toBeNull();
    expect(await delegatedItemRepository.claim(id, at(101), 100)).toBe(true);

    await delegatedItemRepository.markSettled(id, settled, at(102));
    expect(await delegatedItemRepository.claim(id, at(1000), 100)).toBe(false);
  });

  it('marks a pending item failed with its reason', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();
    expect(await delegatedItemRepository.markFailed(id, 'insufficient_credits', at(1))).toBe(true);
    expect(await delegatedItemRepository.findById(id)).toMatchObject({
      status: 'failed',
      failureReason: 'insufficient_credits',
    });
  });

  it('fails only the owner items still pending from before the cutoff', async () => {
    const stale = await insertAt(at(0));
    const fresh = await insertAt(at(100));
    const done = await insertAt(at(0), { status: 'handled', result: 'ok' });
    const theirs = await insertAt(at(0), { userId: 'user-other' });

    expect(await delegatedItemRepository.failStale('user-me', at(50), at(200))).toBe(1);

    const statuses = await Promise.all([stale, fresh, done, theirs].map(id => delegatedItemRepository.findById(id)));
    expect(statuses.map(s => s?.status)).toEqual(['failed', 'pending', 'handled', 'pending']);
    expect(statuses[0]).toMatchObject({ failureReason: 'timed_out', settledAt: at(200) });
  });
});

describe('delegatedItemRepository brief bookkeeping', () => {
  it('lists the owner unbriefed items created before end, oldest first', async () => {
    const second = await insertAt(at(20));
    const first = await insertAt(at(10));
    await insertAt(at(5), { briefedAt: at(6), status: 'handled' });
    await insertAt(at(1000));
    await insertAt(at(1), { userId: 'user-other' });

    const listed = await delegatedItemRepository.listUnbriefed('user-me', at(1000), 10);
    expect(listed.map(item => item._id.toString())).toEqual([first, second]);
    expect(await delegatedItemRepository.listUnbriefed('user-me', at(1000), 1)).toHaveLength(1);
  });

  it('marks only settled, unbriefed items of the owner as briefed', async () => {
    const handled = await insertAt(at(1), { status: 'handled', result: 'ok' });
    const pending = await insertAt(at(2));
    const theirs = await insertAt(at(3), { userId: 'user-other', status: 'handled', result: 'ok' });

    expect(await delegatedItemRepository.markBriefed('user-me', [handled, pending, theirs], at(10))).toBe(1);
    expect(await delegatedItemRepository.markBriefed('user-me', [handled], at(20))).toBe(0);
    expect(await delegatedItemRepository.markBriefed('user-me', [], at(30))).toBe(0);

    expect((await delegatedItemRepository.findById(handled))?.briefedAt).toEqual(at(10));
    expect((await delegatedItemRepository.findById(pending))?.briefedAt).toBeNull();
    expect((await delegatedItemRepository.findById(theirs))?.briefedAt).toBeNull();
  });
});
