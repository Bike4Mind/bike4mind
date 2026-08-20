import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import type { RecordLakeAccessEventInput } from '@bike4mind/common';
import { LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS, LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS } from '@bike4mind/common';
import { lakeAccessEventRepository as repo, LakeAccessEventModel } from './LakeAccessEventModel';
import { LakeAccessQueryTextModel } from './LakeAccessQueryTextModel';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const baseInput = (overrides: Partial<RecordLakeAccessEventInput> = {}): RecordLakeAccessEventInput => ({
  principalKind: 'user',
  principalId: 'alice',
  resolvedLakeIds: [],
  surface: 'data-lake-semantic-search',
  ...overrides,
});

const optedInLake = async (auditQueryTextEnabled = true) => {
  const lake = await dataLakeRepository.create({
    name: 'lake',
    slug: `lake-${Math.random().toString(36).slice(2)}`,
    fileTagPrefix: 'lk:',
    datalakeTag: `datalake:${Math.random().toString(36).slice(2)}`,
    createdByUserId: 'owner',
    status: 'active',
    auditQueryTextEnabled,
  } as never);
  return lake.id;
};

describe('LakeAccessEventModel / lakeAccessEventRepository.record', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included), and these models are not in
  // its one-time ensureIndexes list - rebuild TTL/query indexes per test so index-shaped
  // assertions below are real, not accidentally passing because a prior run's index lingers.
  // Fake timers give every test a deterministic `now` without `record()` accepting one as an
  // input - a caller-facing clock override would let anyone backdate an event past its own
  // floor-clamped retention window (the floor only bounds the DURATION, not the origin point).
  beforeEach(async () => {
    await Promise.all([LakeAccessEventModel.ensureIndexes(), LakeAccessQueryTextModel.ensureIndexes()]);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('persistence fidelity', () => {
    it('round-trips every input field, including array order and length', async () => {
      const event = await repo.record(
        baseInput({
          principalKind: 'agent',
          principalId: 'agent-1',
          onBehalfOfUserId: 'alice',
          organizationId: 'org-1',
          resolvedLakeIds: ['lake-a', 'lake-b', 'lake-c'],
          chunkIds: ['c1'],
          surface: 'forced-retrieval',
        })
      );

      expect(event.principalKind).toBe('agent');
      expect(event.principalId).toBe('agent-1');
      expect(event.onBehalfOfUserId).toBe('alice');
      expect(event.organizationId).toBe('org-1');
      expect(event.resolvedLakeIds).toEqual(['lake-a', 'lake-b', 'lake-c']);
      expect(event.returnedChunkIds).toEqual(['c1']);
      expect(event.returnedChunkCount).toBe(1);
      expect(event.surface).toBe('forced-retrieval');
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('is absent updatedAt - an audit row that reports being updated is a lie', async () => {
      const event = await repo.record(baseInput());
      expect((event as unknown as { updatedAt?: Date }).updatedAt).toBeUndefined();
    });

    it('persists an empty resolvedLakeIds/chunkIds as valid (a zero-result retrieval is still an event)', async () => {
      const event = await repo.record(baseInput());
      expect(event.resolvedLakeIds).toEqual([]);
      expect(event.returnedChunkIds).toEqual([]);
      expect(event.returnedChunkCount).toBe(0);
    });

    it('rejects an unknown surface or principalKind', async () => {
      await expect(
        LakeAccessEventModel.create({
          principalKind: 'user',
          principalId: 'a',
          surface: 'not-a-real-surface',
          returnedChunkCount: 0,
          returnedFileCount: 0,
          expiresAt: new Date(),
        } as never)
      ).rejects.toThrow();
      await expect(
        LakeAccessEventModel.create({
          principalKind: 'not-a-real-kind',
          principalId: 'a',
          surface: 'chat-kb-search',
          returnedChunkCount: 0,
          returnedFileCount: 0,
          expiresAt: new Date(),
        } as never)
      ).rejects.toThrow();
    });

    it('rejects a write with no expiresAt', async () => {
      await expect(
        LakeAccessEventModel.create({
          principalKind: 'user',
          principalId: 'a',
          surface: 'chat-kb-search',
          returnedChunkCount: 0,
          returnedFileCount: 0,
        } as never)
      ).rejects.toThrow();
    });

    it('tracks chunk and file counts separately - a file-only surface must not silently lose its count', async () => {
      const event = await repo.record(baseInput({ surface: 'chat-kb-retrieve', fileIds: ['f1', 'f2'] }));
      expect(event.returnedChunkCount).toBe(0);
      expect(event.returnedFileCount).toBe(2);
    });
  });

  describe('no corpus copy', () => {
    it('drops an unknown chunkText-shaped key rather than persisting it', async () => {
      const event = await LakeAccessEventModel.create({
        principalKind: 'user',
        principalId: 'a',
        surface: 'chat-kb-search',
        returnedChunkCount: 0,
        returnedFileCount: 0,
        expiresAt: new Date(),
        chunkText: 'this must never be stored',
      } as never);
      expect((event.toObject() as Record<string, unknown>).chunkText).toBeUndefined();
    });

    it('has no schema path resembling stored text (corpus-leak guard)', () => {
      // queryTextLogged is a boolean OUTCOME flag, not a content field - it deliberately contains
      // "text" in its name and is the one allowed exception.
      const paths = Object.keys(LakeAccessEventModel.schema.paths).filter(p => p !== 'queryTextLogged');
      const suspicious = paths.filter(p => /text|content|body|snippet|passage/i.test(p));
      expect(suspicious).toEqual([]);
    });

    it('rejects an identifier that looks like passage text, not a short id - the naming-convention guard alone cannot catch this', async () => {
      await expect(repo.record(baseInput({ chunkIds: ['x'.repeat(1000)] }))).rejects.toThrow();
      await expect(repo.record(baseInput({ fileIds: ['x'.repeat(1000)] }))).rejects.toThrow();
    });
  });

  describe('query-text opt-in (unanimity, fail-closed)', () => {
    it('logs query text when every resolved lake has opted in', async () => {
      const lakeA = await optedInLake(true);
      const lakeB = await optedInLake(true);

      const event = await repo.record(
        baseInput({ resolvedLakeIds: [lakeA, lakeB], queryText: 'what is our refund policy?' })
      );

      expect(event.queryTextLogged).toBe(true);
      const stored = await LakeAccessQueryTextModel.findById(event.id);
      expect(stored?.queryText).toBe('what is our refund policy?');
    });

    it('does NOT log when only one of two resolved lakes opted in', async () => {
      const lakeA = await optedInLake(true);
      const lakeB = await optedInLake(false);

      const event = await repo.record(baseInput({ resolvedLakeIds: [lakeA, lakeB], queryText: 'sensitive question' }));

      expect(event.queryTextLogged).toBe(false);
      expect(await LakeAccessQueryTextModel.countDocuments({})).toBe(0);
    });

    it('does NOT log when no lake opted in', async () => {
      const lakeA = await optedInLake(false);
      const event = await repo.record(baseInput({ resolvedLakeIds: [lakeA], queryText: 'question' }));
      expect(event.queryTextLogged).toBe(false);
    });

    it('does NOT log for an empty resolvedLakeIds - vacuous unanimity must fail closed, not open', async () => {
      const event = await repo.record(baseInput({ resolvedLakeIds: [], queryText: 'question with no scope' }));
      expect(event.queryTextLogged).toBe(false);
      expect(await LakeAccessQueryTextModel.countDocuments({})).toBe(0);
    });

    it('does NOT log when opted-in but no query text is supplied', async () => {
      const lakeA = await optedInLake(true);
      const event = await repo.record(baseInput({ resolvedLakeIds: [lakeA] }));
      expect(event.queryTextLogged).toBe(false);
    });

    it('does NOT log when the query text is whitespace-only', async () => {
      const lakeA = await optedInLake(true);
      const event = await repo.record(baseInput({ resolvedLakeIds: [lakeA], queryText: '   ' }));
      expect(event.queryTextLogged).toBe(false);
    });

    it('does NOT throw and does NOT log when resolvedLakeIds mixes a real id with a non-ObjectId registry slug', async () => {
      const lakeA = await optedInLake(true);
      const event = await repo.record(
        baseInput({ resolvedLakeIds: [lakeA, 'registry-slug-not-an-objectid'], queryText: 'question' })
      );
      expect(event.queryTextLogged).toBe(false);
      expect(await LakeAccessQueryTextModel.countDocuments({})).toBe(0);
    });

    it('truncates query text over the cap and flags it', async () => {
      const lakeA = await optedInLake(true);
      const longText = 'x'.repeat(5000);
      const event = await repo.record(baseInput({ resolvedLakeIds: [lakeA], queryText: longText }));
      expect(event.queryTextLogged).toBe(true);
      const stored = await LakeAccessQueryTextModel.findById(event.id);
      expect(stored?.queryText.length).toBe(4000);
      expect(stored?.queryTextTruncated).toBe(true);
    });

    it('reports queryTextLogged=false, not a lie, when the opted-in text write itself fails', async () => {
      // Every other test here proves the OPT-IN decision; this one proves the OUTCOME still wins
      // when the decision was "yes" but the actual write throws - the exact bug the write-before
      // ordering in `record()` exists to prevent.
      const lakeA = await optedInLake(true);
      const createSpy = vi
        .spyOn(LakeAccessQueryTextModel, 'create')
        .mockRejectedValueOnce(new Error('simulated write failure'));

      const event = await repo.record(
        baseInput({ resolvedLakeIds: [lakeA], queryText: 'this should not be lost silently' })
      );

      expect(event.queryTextLogged).toBe(false);
      expect(await LakeAccessQueryTextModel.countDocuments({})).toBe(0);
      createSpy.mockRestore();
    });

    it('deletes the already-written query text when the EVENT write itself then fails - no orphaned record of a question with no audit context', async () => {
      const lakeA = await optedInLake(true);
      // An invalid surface passes everyLakeOptedIn (which never looks at `surface`) and fails
      // only at the final eventModel.create() - exactly the ordering the cleanup path covers.
      await expect(
        repo.record(
          baseInput({ resolvedLakeIds: [lakeA], queryText: 'orphan risk', surface: 'not-a-real-surface' as never })
        )
      ).rejects.toThrow();

      expect(await LakeAccessQueryTextModel.countDocuments({})).toBe(0);
      expect(await LakeAccessEventModel.countDocuments({})).toBe(0);
    });
  });

  describe('retention floor', () => {
    it('clamps a below-floor retentionDays up to the floor', async () => {
      const event = await repo.record(baseInput({ retentionDays: 30 }));
      const days = (event.expiresAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS, 3);
    });

    it('defaults to the floor when retentionDays is omitted', async () => {
      const event = await repo.record(baseInput());
      const days = (event.expiresAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS, 3);
    });

    it('clamps an above-ceiling retentionDays down to the max', async () => {
      const event = await repo.record(baseInput({ retentionDays: 10_000 }));
      const days = (event.expiresAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS, 3);
    });

    it('the query-text expiresAt is strictly earlier than the event expiresAt, even at an absurdly high queryTextRetentionDays', async () => {
      const lakeA = await optedInLake(true);
      const event = await repo.record(
        baseInput({ resolvedLakeIds: [lakeA], queryText: 'q', queryTextRetentionDays: 999_999 })
      );
      const textDoc = await LakeAccessQueryTextModel.findById(event.id);
      expect(textDoc!.expiresAt.getTime()).toBeLessThan(event.expiresAt.getTime());
    });

    it('carries the _id tie-break on both read indexes, so their sorts stay index-served', async () => {
      const indexes = await LakeAccessEventModel.collection.indexes();
      expect(
        indexes.some(idx => idx.key?.resolvedLakeIds === 1 && idx.key?.createdAt === -1 && idx.key?._id === -1)
      ).toBe(true);
      expect(
        indexes.some(
          idx =>
            idx.key?.principalKind === 1 &&
            idx.key?.principalId === 1 &&
            idx.key?.createdAt === -1 &&
            idx.key?._id === -1
        )
      ).toBe(true);
    });

    it('has a TTL index (expireAfterSeconds: 0) on expiresAt for BOTH collections', async () => {
      const eventIndexes = await LakeAccessEventModel.collection.indexes();
      const ttlEvent = eventIndexes.find(idx => idx.key?.expiresAt === 1);
      expect(ttlEvent?.expireAfterSeconds).toBe(0);

      const textIndexes = await LakeAccessQueryTextModel.collection.indexes();
      const ttlText = textIndexes.find(idx => idx.key?.expiresAt === 1);
      expect(ttlText?.expireAfterSeconds).toBe(0);
    });

    it('is not fooled by system-clock manipulation - record() always uses the real clock, not a caller-supplied one', async () => {
      // RecordLakeAccessEventInput has no `now` field; this asserts the type-level removal holds
      // at runtime too - an extra `now` on the input object is simply ignored.
      const event = await repo.record({ ...baseInput(), now: new Date('2020-01-01') } as never);
      const days = (event.expiresAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS, 3);
    });
  });

  describe('identifier caps', () => {
    it('truncates chunk ids past the cap while reporting the true pre-truncation count', async () => {
      const manyIds = Array.from({ length: 600 }, (_, i) => `chunk-${i}`);
      const event = await repo.record(baseInput({ chunkIds: manyIds }));
      expect(event.returnedChunkIds.length).toBe(500);
      expect(event.returnedChunkCount).toBe(600);
      expect(event.identifiersTruncated).toBe(true);
    });
  });

  describe('the floor cannot be bypassed via mutation', () => {
    it('a raw updateOne setting expiresAt is a no-op - the schema marks it immutable', async () => {
      const event = await repo.record(baseInput());
      const originalExpiresAt = event.expiresAt;

      await LakeAccessEventModel.updateOne({ _id: event.id }, { $set: { expiresAt: new Date('2099-01-01') } });

      const reloaded = await LakeAccessEventModel.findById(event.id);
      expect(reloaded!.expiresAt.getTime()).toBe(new Date(originalExpiresAt).getTime());
    });

    it('documents (does not hide) the real Mongoose escape hatch: overwriteImmutable bypasses the guard', async () => {
      // Honesty check for the claim in LakeAccessEventModel.ts's schema comment: `immutable`
      // is NOT an absolute guarantee in this Mongoose version - it is stripped from a query
      // update UNLESS the caller passes `overwriteImmutable: true`. This test exists so that
      // fact is asserted, not assumed - and so the guard test below (grepping for exactly this
      // escape hatch) has a reason to exist.
      const event = await repo.record(baseInput());
      await LakeAccessEventModel.updateOne(
        { _id: event.id },
        { $set: { expiresAt: new Date('2020-01-01') } },
        { overwriteImmutable: true }
      );
      const reloaded = await LakeAccessEventModel.findById(event.id);
      expect(reloaded!.expiresAt.getTime()).toBe(new Date('2020-01-01').getTime());
    });

    it('no other source file writes to LakeAccessEventModel/LakeAccessQueryTextModel outside their own repository methods', () => {
      const repoRoot = path.resolve(__dirname, '../../../../..');
      const relFromRoot = (p: string) => path.relative(repoRoot, p).split(path.sep).join('/');
      const allowedFiles = new Set([
        relFromRoot(path.resolve(__dirname, 'LakeAccessEventModel.test.ts')),
        relFromRoot(path.resolve(__dirname, 'LakeAccessEventModel.ts')),
        relFromRoot(path.resolve(__dirname, 'LakeAccessQueryTextModel.ts')),
      ]);
      // `git grep` only searches TRACKED files (no explicit node_modules/.git/dist skip-list
      // needed) and is dramatically faster than a synchronous fs walk of the whole monorepo -
      // the walk this replaced timed out CI's 15s default even though it ran in well under a
      // second locally. Covers the ordinary query-update verbs AND the raw-driver/collection
      // escape hatch and overwriteImmutable, on BOTH models. Cannot catch an aliased import
      // (`import { LakeAccessEventModel as X }`), a real limit of a text-pattern guard.
      const pattern =
        '(LakeAccessEventModel|LakeAccessQueryTextModel)\\s*\\.\\s*(updateOne|updateMany|findOneAndUpdate|bulkWrite|replaceOne|collection)\\s*[.(]';
      let output = '';
      try {
        output = execFileSync('git', ['grep', '-lP', pattern, '--', '*.ts', '*.tsx'], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
      } catch (err) {
        // Exit code 1 from `git grep` means "no matches" - not a real error.
        if ((err as { status?: number }).status !== 1) throw err;
      }
      const offenders = output
        .split('\n')
        .filter(Boolean)
        .filter(file => !allowedFiles.has(file));

      expect(offenders).toEqual([]);
    });
  });

  describe('reads', () => {
    it('listByLake finds only events whose resolvedLakeIds contains the lake', async () => {
      await repo.record(baseInput({ resolvedLakeIds: ['lake-x'] }));
      await repo.record(baseInput({ resolvedLakeIds: ['lake-y'] }));

      const results = await repo.listByLake('lake-x');
      expect(results).toHaveLength(1);
      expect(results[0].resolvedLakeIds).toContain('lake-x');
    });

    it('listByLake returns newest first, so a limited read is the most recent window', async () => {
      // Pinned because assembleLakeAccessView reads `windowStartsAt` off the LAST element of a
      // truncated fetch: a sort change here would silently publish the wrong window start on a
      // compliance export, with nothing else to catch it.
      await repo.record(baseInput({ resolvedLakeIds: ['lake-o'], principalId: 'oldest' }));
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      await repo.record(baseInput({ resolvedLakeIds: ['lake-o'], principalId: 'middle' }));
      vi.setSystemTime(new Date(NOW.getTime() + 120_000));
      await repo.record(baseInput({ resolvedLakeIds: ['lake-o'], principalId: 'newest' }));

      const results = await repo.listByLake('lake-o');
      expect(results.map(r => r.principalId)).toEqual(['newest', 'middle', 'oldest']);
      // With a limit it must drop the OLDEST, and the last row is then the window's start.
      const limited = await repo.listByLake('lake-o', { limit: 2 });
      expect(limited.map(r => r.principalId)).toEqual(['newest', 'middle']);
    });

    // Reads are high volume, so two events landing in the same millisecond is ordinary here, not
    // exotic. `createdAt` alone is a PARTIAL order: the engine may return a tied pair either way
    // round, which makes a fixed-size window non-reproducible - it changes WHICH rows the window
    // contains, so `assembleLakeAccessView` can publish a different `windowStartsAt` for the same
    // request. Pinned as the sort SPEC on both readers, since no test can force the engine to
    // actually exercise its freedom to reorder a tie (see the config-event sibling test).
    it('sorts both readers on a total order, so same-createdAt events cannot come back reordered', async () => {
      const findSpy = vi.spyOn(LakeAccessEventModel, 'find');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const event = await repo.record(baseInput({ resolvedLakeIds: ['lake-tie'], principalId: 'tied' }));
        ids.push(String(event.id));
      }
      const expected = [...ids].reverse();

      const byLake = await repo.listByLake('lake-tie');
      const byPrincipal = await repo.listByPrincipal('user', 'tied');
      const windowed = await repo.listByLake('lake-tie', { limit: 3 });
      expect(findSpy.mock.results.map(r => r.value.getOptions().sort)).toEqual([
        { createdAt: -1, _id: -1 },
        { createdAt: -1, _id: -1 },
        { createdAt: -1, _id: -1 },
      ]);
      findSpy.mockRestore();

      const stored = await LakeAccessEventModel.find({ resolvedLakeIds: 'lake-tie' }).lean();
      expect(new Set(stored.map(e => e.createdAt.getTime())).size).toBe(1);
      expect(byLake.map(e => String(e.id))).toEqual(expected);
      expect(byPrincipal.map(e => String(e.id))).toEqual(expected);
      expect(windowed.map(e => String(e.id))).toEqual(expected.slice(0, 3));
    });

    // The tie-break must be in the index key, not just the sort: otherwise it buys a stable order
    // at the cost of a blocking in-memory SORT on the highest-volume audit collection.
    it('serves both audit sorts from an index, with no in-memory SORT stage', async () => {
      const byLake = await LakeAccessEventModel.find({ resolvedLakeIds: 'lake-tie' })
        .sort({ createdAt: -1, _id: -1 })
        .explain('queryPlanner');
      expect(JSON.stringify(byLake)).not.toContain('"stage":"SORT"');
      expect(JSON.stringify(byLake)).toContain('IXSCAN');

      const byPrincipal = await LakeAccessEventModel.find({ principalKind: 'user', principalId: 'tied' })
        .sort({ createdAt: -1, _id: -1 })
        .explain('queryPlanner');
      expect(JSON.stringify(byPrincipal)).not.toContain('"stage":"SORT"');
      expect(JSON.stringify(byPrincipal)).toContain('IXSCAN');
    });

    it('two identical record() calls produce two rows - no dedupe, by design', async () => {
      await repo.record(baseInput({ principalId: 'dup-test' }));
      await repo.record(baseInput({ principalId: 'dup-test' }));
      const results = await repo.listByPrincipal('user', 'dup-test');
      expect(results).toHaveLength(2);
    });
  });
});
