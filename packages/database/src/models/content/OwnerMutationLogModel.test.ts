import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import {
  OWNER_MIRROR_COVERAGE,
  OWNER_MIRROR_COVERAGE_COMPLETE,
  OWNER_MIRROR_UNINSTRUMENTED_RECORDS,
  OwnerMutationCoverageError,
  OwnerMutationCursorError,
  OwnerMutationHead,
  OwnerMutationLog,
  pruneOwnerMutations,
  readOwnerMutations,
  readOwnerMutationsInternal,
  writeOwnerMutation,
} from './OwnerMutationLogModel';

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const source = mongoose.model('OwnerMutationTestSource', new mongoose.Schema({ ownerId: String, value: String }));
const input = (beforeOwners: string[], afterOwners: string[], version = 'v1') => ({
  recordType: 'test-record',
  recordId: 'record-1',
  beforeOwners,
  afterOwners,
  version,
});

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([
    source.createCollection(),
    OwnerMutationHead.createCollection(),
    OwnerMutationLog.createCollection(),
  ]);
  await OwnerMutationLog.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Promise.all([
    source.collection.deleteMany({}),
    OwnerMutationLog.collection.deleteMany({}),
    OwnerMutationHead.collection.deleteMany({}),
  ]);
});

describe('owner mutation outbox', () => {
  it('does not expose the feed while direct writers are uninstrumented', async () => {
    expect(OWNER_MIRROR_COVERAGE).toEqual({
      databasePrivilegesEnforced: false,
      accountSnapshotFenced: false,
      immutableByteReferencesFenced: false,
      includedWritersInstrumented: false,
    });
    expect(OWNER_MIRROR_UNINSTRUMENTED_RECORDS).toContain('FabFile');
    expect(OWNER_MIRROR_UNINSTRUMENTED_RECORDS).toContain('Session');
    expect(OWNER_MIRROR_COVERAGE_COMPLETE).toBe(false);
    await expect(readOwnerMutations('alice', 10)).rejects.toBeInstanceOf(OwnerMutationCoverageError);
  });

  it('rolls back both source and outbox when the writer or append fails', async () => {
    await expect(
      writeOwnerMutation(input([], ['alice']), async session => {
        await source.collection.insertOne({ ownerId: 'alice' }, { session });
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');
    expect(await source.countDocuments()).toBe(0);
    expect(await OwnerMutationLog.countDocuments()).toBe(0);

    const insert = vi.spyOn(OwnerMutationLog, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    try {
      await expect(
        writeOwnerMutation(input([], ['alice']), async session => {
          await source.collection.insertOne({ ownerId: 'alice' }, { session });
        })
      ).rejects.toThrow('outbox unavailable');
    } finally {
      insert.mockRestore();
    }
    expect(await source.countDocuments()).toBe(0);
    expect(await OwnerMutationLog.countDocuments()).toBe(0);
  });

  it('emits old-owner tombstones and new-owner references for a transfer', async () => {
    await writeOwnerMutation(input(['alice', 'shared'], ['bob', 'shared'], 'v2'), async session => {
      await source.collection.insertOne({ ownerId: 'bob', value: 'v2' }, { session });
    });
    const alice = await readOwnerMutationsInternal('alice', 10);
    const bob = await readOwnerMutationsInternal('bob', 10);
    const shared = await readOwnerMutationsInternal('shared', 10);
    expect(alice.events.map(event => [event.kind, event.version])).toEqual([['delete', null]]);
    expect(bob.events.map(event => [event.kind, event.version])).toEqual([['upsert', 'v2']]);
    expect(shared.events.map(event => [event.kind, event.version])).toEqual([['upsert', 'v2']]);
    expect((await readOwnerMutationsInternal('stranger', 10)).events).toEqual([]);
  });

  it('keeps hard-delete owner identity after the source row is removed', async () => {
    await source.collection.insertOne({ ownerId: 'alice' });
    await writeOwnerMutation(input(['alice'], [], 'prior-version'), async session => {
      await source.collection.deleteOne({ ownerId: 'alice' }, { session });
    });
    expect(await source.countDocuments()).toBe(0);
    expect((await readOwnerMutationsInternal('alice', 10)).events[0]).toMatchObject({
      ownerId: 'alice',
      recordId: 'record-1',
      kind: 'delete',
      version: null,
    });
  });

  it('serializes concurrent appends, verifies the chain and replays without gaps', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        writeOwnerMutation({ ...input([], ['alice']), recordId: `r${index}` }, async session => {
          await source.collection.insertOne({ ownerId: 'alice', value: String(index) }, { session });
        })
      )
    );
    const first = await readOwnerMutationsInternal('alice', 2);
    const second = await readOwnerMutationsInternal('alice', 2, first.nextCursor);
    const third = await readOwnerMutationsInternal('alice', 2, second.nextCursor);
    const events = [...first.events, ...second.events, ...third.events];
    expect(events.map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(events[0].prevHash).toBeNull();
    for (let index = 1; index < events.length; index++) expect(events[index].prevHash).toBe(events[index - 1].hash);
    expect((await readOwnerMutationsInternal('alice', 2, third.nextCursor)).events).toEqual([]);
    expect(first.lagMs).toBeNull();
    await expect(readOwnerMutationsInternal('bob', 2, first.nextCursor)).rejects.toBeInstanceOf(
      OwnerMutationCursorError
    );
  });

  it('expires pruned cursors and retains a verifiable floor', async () => {
    for (let index = 0; index < 3; index++) {
      await writeOwnerMutation({ ...input([], ['alice']), recordId: `r${index}` }, async session => {
        await source.collection.insertOne({ ownerId: 'alice', value: String(index) }, { session });
      });
    }
    const first = await readOwnerMutationsInternal('alice', 1);
    const second = await readOwnerMutationsInternal('alice', 1, first.nextCursor);
    await pruneOwnerMutations('alice', 2);
    await expect(readOwnerMutationsInternal('alice', 2, first.nextCursor)).rejects.toThrow('expired');
    const remaining = await readOwnerMutationsInternal('alice', 2, second.nextCursor);
    expect(remaining.events.map(row => row.seq)).toEqual([3]);
    expect(remaining.events[0].prevHash).toBe(second.events[0].hash);
  });

  it('rejects a missing event rather than silently paging past it', async () => {
    for (let index = 0; index < 3; index++) {
      await writeOwnerMutation({ ...input([], ['alice']), recordId: `r${index}` }, async session => {
        await source.collection.insertOne({ ownerId: 'alice' }, { session });
      });
    }
    const first = await readOwnerMutationsInternal('alice', 1);
    await OwnerMutationLog.collection.deleteOne({ ownerId: 'alice', seq: 2 });
    await expect(readOwnerMutationsInternal('alice', 2, first.nextCursor)).rejects.toThrow('gap');
    await expect(pruneOwnerMutations('alice', 3)).rejects.toThrow('gap');
    expect((await OwnerMutationHead.findById('alice'))?.floorSeq).toBe(0);
  });
});
