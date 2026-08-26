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

    it('round-trips questId and sessionId (#1867 turn linkage)', async () => {
      const event = await repo.record(baseInput({ questId: 'quest-1', sessionId: 'session-1' }));
      expect(event.questId).toBe('quest-1');
      expect(event.sessionId).toBe('session-1');
    });

    it('leaves questId/sessionId absent, not null or empty string, when the caller supplies neither', async () => {
      const event = await repo.record(baseInput());
      expect(event.questId).toBeUndefined();
      expect(event.sessionId).toBeUndefined();
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

    it('has a TTL index (expireAfterSeconds: 0) on expiresAt for BOTH collections', async () => {
      const eventIndexes = await LakeAccessEventModel.collection.indexes();
      const ttlEvent = eventIndexes.find(idx => idx.key?.expiresAt === 1);
      expect(ttlEvent?.expireAfterSeconds).toBe(0);

      const textIndexes = await LakeAccessQueryTextModel.collection.indexes();
      const ttlText = textIndexes.find(idx => idx.key?.expiresAt === 1);
      expect(ttlText?.expireAfterSeconds).toBe(0);
    });

    it('has a sparse questId index (#1867 turn linkage) - most rows have none, so plain would waste space', async () => {
      const indexes = await LakeAccessEventModel.collection.indexes();
      const questIdIndex = indexes.find(idx => idx.key?.questId === 1);
      expect(questIdIndex?.sparse).toBe(true);
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

    it('truncates scores in lockstep with chunkIds at the same 500-element boundary (#1867)', async () => {
      const manyIds = Array.from({ length: 600 }, (_, i) => `chunk-${i}`);
      const manyScores = Array.from({ length: 600 }, (_, i) => i / 600);
      const event = await repo.record(baseInput({ chunkIds: manyIds, scores: manyScores }));
      expect(event.scores?.length).toBe(500);
      expect(event.scores).toEqual(manyScores.slice(0, 500));
      expect(event.returnedChunkIds.length).toBe(event.scores?.length);
    });
  });

  describe('scores (#1867 similarity scores)', () => {
    it('round-trips scores index-aligned with chunkIds', async () => {
      const event = await repo.record(baseInput({ chunkIds: ['c1', 'c2', 'c3'], scores: [0.9, 0.8, 0.7] }));
      expect(event.scores).toEqual([0.9, 0.8, 0.7]);
      expect(event.returnedChunkIds).toEqual(['c1', 'c2', 'c3']);
    });

    it('leaves scores absent (not an empty array) when the caller supplies none - distinguishes no-score-concept from ran-found-nothing', async () => {
      const event = await repo.record(baseInput({ chunkIds: ['c1'] }));
      expect(event.scores).toBeUndefined();
    });

    it('drops a mismatched-length scores array rather than risk misattributing a score to the wrong chunk', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const event = await repo.record(baseInput({ chunkIds: ['c1', 'c2'], scores: [0.9] }));
      expect(event.scores).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scores.length'));
      warnSpy.mockRestore();
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
        // An index migration's integration test legitimately needs raw collection access: it
        // asserts on `.indexes()` and resets state between cases, neither of which the repository
        // exposes (nor should it - `record` is the only write verb by design). Declared here as an
        // explicit exception rather than routed through `mongoose.connection.db` to dodge the
        // pattern: evading a text guard leaves the same capability with none of the visibility,
        // and it would decouple the collection name from the model. The guard's real subject is
        // production code bypassing `record()` to mutate `expiresAt`; a migration test does not.
        'packages/scripts/migrate/migrations/20260820000000_ensure-lakeaccessevent-questid-index.integration.test.ts',
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

    it('listByLake orders same-millisecond events stably across repeated paged loads', async () => {
      // Same clock for every write, so `createdAt` alone leaves the order to Mongo - and the row a
      // page of 3 cuts at its boundary would then differ between two loads of that same page.
      for (let i = 0; i < 5; i++) {
        await repo.record(baseInput({ resolvedLakeIds: ['lake-tie'], principalId: `p${i}` }));
      }

      const page = async () => (await repo.listByLake('lake-tie', { limit: 3 })).map(r => r.principalId);
      // Newest-first with the _id tie-break is reverse insertion order, ObjectIds being monotonic
      // within a process.
      expect(await page()).toEqual(['p4', 'p3', 'p2']);
      expect(await page()).toEqual(['p4', 'p3', 'p2']);
    });

    it('two identical record() calls produce two rows - no dedupe, by design', async () => {
      await repo.record(baseInput({ principalId: 'dup-test' }));
      await repo.record(baseInput({ principalId: 'dup-test' }));
      const results = await repo.listByPrincipal('user', 'dup-test');
      expect(results).toHaveLength(2);
    });
  });
});
