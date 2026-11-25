import { withTransaction } from '@bike4mind/db-core';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { DelegatedItemModel, delegatedItemRepository, type DelegatedItemInput } from './DelegatedItemModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { monitorCommands: true });
  await settleAutoIndexBuilds(mongoose);
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

    expect(await delegatedItemRepository.claim(id, at(0), 100, 'test-owner')).toBe(true);
    expect(await delegatedItemRepository.claim(id, at(50), 100, 'test-owner')).toBe(false);
    expect(await delegatedItemRepository.claim(id, at(100), 100, 'test-owner')).toBe(true);
    // The first delivery's lease (ending at 100) has been taken over; releasing it leaves the newer claim alone.
    await delegatedItemRepository.releaseClaim(id, at(100), 'test-owner');
    expect((await delegatedItemRepository.findById(id))?.claimedUntil).toEqual(at(200));
    await delegatedItemRepository.releaseClaim(id, at(200), 'test-owner');
    expect((await delegatedItemRepository.findById(id))?.claimedUntil).toBeNull();
    expect(await delegatedItemRepository.claim(id, at(101), 100, 'test-owner')).toBe(true);

    await delegatedItemRepository.markSettled(id, settled, at(102));
    expect(await delegatedItemRepository.claim(id, at(1000), 100, 'test-owner')).toBe(false);
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

describe('owner-fenced delegation processing', () => {
  const leaseMs = 180_000;
  it('renews healthy ownership and rejects all stale A mutations after B takeover', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();
    expect(await delegatedItemRepository.claim(id, at(0), leaseMs, 'A')).toBe(true);
    const renewed = await delegatedItemRepository.renewClaim(id, 'A', at(leaseMs), at(120_000), leaseMs);
    expect(renewed).toEqual(at(300_000));
    expect(await delegatedItemRepository.claim(id, at(240_000), leaseMs, 'B')).toBe(false);
    expect(await delegatedItemRepository.claim(id, at(300_000), leaseMs, 'B')).toBe(true);
    expect(await delegatedItemRepository.renewClaim(id, 'A', at(300_000), at(300_001), leaseMs)).toBeNull();
    expect(await delegatedItemRepository.fenceClaim(id, 'A', at(300_001))).toBe(false);
    expect(await delegatedItemRepository.markSettledOwned(id, 'A', settled, at(300_001))).toBe(false);
    expect(await delegatedItemRepository.markFailedOwned(id, 'A', 'late', at(300_001))).toBe(false);
    await delegatedItemRepository.releaseClaim(id, at(300_000), 'A');
    expect(await delegatedItemRepository.findById(id)).toMatchObject({ claimToken: 'B', status: 'pending' });
    expect(await delegatedItemRepository.markSettledOwned(id, 'B', settled, at(300_002))).toBe(true);
  });
  it('never revives an expired claim and excludes a healthy claim from the stale sweep', async () => {
    const id = await insertAt(at(0));
    await delegatedItemRepository.claim(id, at(0), leaseMs, 'A');
    expect(await delegatedItemRepository.failStale('user-me', at(1), at(100_000))).toBe(0);
    expect(await delegatedItemRepository.renewClaim(id, 'A', at(leaseMs), at(leaseMs), leaseMs)).toBeNull();
    expect(await delegatedItemRepository.failStale('user-me', at(1), at(leaseMs))).toBe(1);
  });
  it('rolls terminal state and DB accounting back together; retry reuses already buffered provider output', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();
    await delegatedItemRepository.claim(id, at(0), leaseMs, 'A');
    // A minimal real DB accounting target tests the callback's transaction boundary, not price policy.
    const Accounting =
      (mongoose.models.DelegationAccounting as mongoose.Model<{ balance: number }> | undefined) ??
      mongoose.model(
        'DelegationAccounting',
        new mongoose.Schema<{ balance: number }>({ balance: { type: Number, required: true } })
      );
    await Accounting.createCollection();
    const account = await Accounting.create({ balance: 100 });
    let providerCalls = 0;
    const buffered = (() => {
      providerCalls++;
      return settled;
    })();
    const finalize = (fail: boolean) =>
      withTransaction(async session => {
        expect(await delegatedItemRepository.markSettledOwned(id, 'A', buffered, at(1), session)).toBe(true);
        await Accounting.updateOne({ _id: account._id }, { $inc: { balance: -10 } }, { session });
        if (fail) throw new Error('after debit before commit');
      });
    await expect(finalize(true)).rejects.toThrow('after debit before commit');
    expect((await delegatedItemRepository.findById(id))?.status).toBe('pending');
    expect((await Accounting.findById(account._id).lean())?.balance).toBe(100);
    await finalize(false);
    expect((await delegatedItemRepository.findById(id))?.status).toBe('handled');
    expect((await Accounting.findById(account._id).lean())?.balance).toBe(90);
    expect(providerCalls).toBe(1);
    await Accounting.deleteMany({});
  });
  it('keeps a DB finalizer exclusive when takeover starts after nominal expiry', async () => {
    const id = (await delegatedItemRepository.create(input()))._id.toString();
    await delegatedItemRepository.claim(id, at(0), leaseMs, 'A');
    let release!: () => void;
    let locked!: () => void;
    let commandStarted!: () => void;
    const proceed = new Promise<void>(done => {
      release = done;
    });
    const terminalLocked = new Promise<void>(done => {
      locked = done;
    });
    const contenderStarted = new Promise<void>(done => {
      commandStarted = done;
    });
    const client = mongoose.connection.getClient();
    const monitor = (event: mongoose.mongo.CommandStartedEvent) => {
      const command = event.command as { updates?: { u?: { $set?: { claimToken?: unknown } } }[] };
      if (event.commandName === 'update' && command.updates?.some(update => update.u?.$set?.claimToken === 'B'))
        commandStarted();
    };
    client.on('commandStarted', monitor);
    let finalized = 0;
    try {
      const first = withTransaction(async session => {
        expect(await delegatedItemRepository.markSettledOwned(id, 'A', settled, at(1), session)).toBe(true);
        locked();
        await proceed;
        // A DB-only usage callback executes behind the terminal write; never an external provider.
      });
      await terminalLocked;
      const second = delegatedItemRepository.claim(id, at(leaseMs), leaseMs, 'B');
      // Release on the conflicting command START, never its blocked completion.
      await contenderStarted;
      release();
      await first;
      finalized++;
      expect(await second).toBe(false);
      expect(finalized).toBe(1);
      expect((await delegatedItemRepository.findById(id))?.status).toBe('handled');
    } finally {
      release();
      client.off('commandStarted', monitor);
    }
  });
});

describe('uncertain claim recovery', () => {
  it('releases an acknowledged-lost renewal by token and cannot resurrect it', async () => {
    const id = await insertAt(at(0));
    expect(await delegatedItemRepository.claim(id, at(0), 180, 'A')).toBe(true);
    expect(await delegatedItemRepository.renewClaim(id, 'A', at(180), at(60), 180)).toEqual(at(240));
    await delegatedItemRepository.releaseClaim(id, at(180), 'A');
    expect((await delegatedItemRepository.findById(id))?.claimedUntil).toEqual(at(240));
    expect(await delegatedItemRepository.releaseClaimOwned(id, 'A')).toBe(true);
    expect(await delegatedItemRepository.renewClaim(id, 'A', at(240), at(120), 180)).toBeNull();
    expect(await delegatedItemRepository.claim(id, at(120), 180, 'B')).toBe(true);
    expect(await delegatedItemRepository.releaseClaimOwned(id, 'A')).toBe(false);
    expect((await delegatedItemRepository.findById(id))?.claimToken).toBe('B');
  });
});
