import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
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
  now: NOW,
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
  beforeEach(async () => {
    await Promise.all([LakeAccessEventModel.ensureIndexes(), LakeAccessQueryTextModel.ensureIndexes()]);
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
          expiresAt: new Date(),
        } as never)
      ).rejects.toThrow();
      await expect(
        LakeAccessEventModel.create({
          principalKind: 'not-a-real-kind',
          principalId: 'a',
          surface: 'chat-kb-search',
          returnedChunkCount: 0,
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
        } as never)
      ).rejects.toThrow();
    });
  });

  describe('no corpus copy', () => {
    it('drops an unknown chunkText-shaped key rather than persisting it', async () => {
      const event = await LakeAccessEventModel.create({
        principalKind: 'user',
        principalId: 'a',
        surface: 'chat-kb-search',
        returnedChunkCount: 0,
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

    it('no other source file calls updateOne/updateMany/findOneAndUpdate on LakeAccessEventModel', () => {
      const repoRoot = path.resolve(__dirname, '../../../../..');
      const thisFile = path.resolve(__dirname, 'LakeAccessEventModel.test.ts');
      const modelFile = path.resolve(__dirname, 'LakeAccessEventModel.ts');
      const skipDirs = new Set(['node_modules', '.git', 'dist', '.turbo', '.next', 'coverage', '.claude']);
      const pattern = /LakeAccessEventModel\s*\.\s*(updateOne|updateMany|findOneAndUpdate)\s*\(/;
      const offenders: string[] = [];

      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            walk(path.join(dir, entry.name));
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            const full = path.join(dir, entry.name);
            if (full === thisFile || full === modelFile) continue;
            if (pattern.test(fs.readFileSync(full, 'utf-8'))) offenders.push(full);
          }
        }
      };
      walk(repoRoot);

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

    it('two identical record() calls produce two rows - no dedupe, by design', async () => {
      await repo.record(baseInput({ principalId: 'dup-test' }));
      await repo.record(baseInput({ principalId: 'dup-test' }));
      const results = await repo.listByPrincipal('user', 'dup-test');
      expect(results).toHaveLength(2);
    });
  });
});
