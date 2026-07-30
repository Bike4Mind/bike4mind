import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

// Regression guard for the dedup bug: an orphaned upload (record created with the
// contentHash but never completed -> status 'pending') must NOT count as an existing
// duplicate, or a legit re-upload after a prior failed upload gets wrongly skipped.
describe('FabFile dedup excludes incomplete uploads', () => {
  const userId = 'u-dedup';

  describe('findByContentHashes', () => {
    it('returns completed records but excludes pending orphans', async () => {
      await FabFile.create({
        userId,
        fileName: 'done.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'done.txt',
        contentHash: 'hash-complete',
        status: 'complete',
      });
      await FabFile.create({
        userId,
        fileName: 'orphan.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'orphan.txt',
        contentHash: 'hash-pending',
        status: 'pending',
      });

      const result = await fabFileRepository.findByContentHashes(userId, ['hash-complete', 'hash-pending']);

      const hashes = result.map(f => f.contentHash);
      expect(hashes).toContain('hash-complete'); // genuine completed duplicate still skipped
      expect(hashes).not.toContain('hash-pending'); // orphan no longer blocks a re-upload
    });

    // $ne 'pending' (not === 'complete') is intentional so records predating the status
    // field (undefined status) keep counting as duplicates - only known-incomplete drops out.
    it('still returns a legacy record that has no status set', async () => {
      await FabFile.collection.insertOne({
        userId,
        fileName: 'legacy.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'legacy.txt',
        contentHash: 'hash-legacy',
        deletedAt: null,
      });

      const result = await fabFileRepository.findByContentHashes(userId, ['hash-legacy']);
      expect(result.map(f => f.contentHash)).toContain('hash-legacy');
    });
  });

  describe('findByContentHashesInDataLake', () => {
    const datalakeTag = 'datalake:test-lake';

    it('returns completed records but excludes pending orphans in the lake', async () => {
      await FabFile.create({
        userId,
        fileName: 'done.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'done.txt',
        contentHash: 'lake-complete',
        status: 'complete',
        tags: [{ name: datalakeTag, strength: 1.0 }],
      });
      await FabFile.create({
        userId,
        fileName: 'orphan.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'orphan.txt',
        contentHash: 'lake-pending',
        status: 'pending',
        tags: [{ name: datalakeTag, strength: 1.0 }],
      });

      const result = await fabFileRepository.findByContentHashesInDataLake(
        ['lake-complete', 'lake-pending'],
        datalakeTag
      );

      const hashes = result.map(f => f.contentHash);
      expect(hashes).toContain('lake-complete');
      expect(hashes).not.toContain('lake-pending');
    });

    // This variant is cross-user by contract (shared-lake dedup), not scoped to userId.
    it('matches a completed record owned by a different user in the same lake', async () => {
      await FabFile.create({
        userId: 'other-user',
        fileName: 'shared.txt',
        mimeType: 'text/plain',
        type: KnowledgeType.FILE,
        filePath: 'shared.txt',
        contentHash: 'lake-shared',
        status: 'complete',
        tags: [{ name: datalakeTag, strength: 1.0 }],
      });

      const result = await fabFileRepository.findByContentHashesInDataLake(['lake-shared'], datalakeTag);
      expect(result.map(f => f.contentHash)).toContain('lake-shared');
    });
  });
});
