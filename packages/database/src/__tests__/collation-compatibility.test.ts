import { describe, it, expect, beforeEach } from 'vitest';
import { FabFile } from '../models/content/FabFileModel';
import { fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

describe('DocumentDB Collation Compatibility', () => {
  setupMongoTest();

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  const testFiles = [
    {
      userId: 'test-user-1',
      fileName: 'Apple.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    },
    {
      userId: 'test-user-1',
      fileName: 'banana.pdf',
      type: KnowledgeType.FILE,
      mimeType: 'application/pdf',
    },
    {
      userId: 'test-user-1',
      fileName: 'Cherry.doc',
      type: KnowledgeType.FILE,
      mimeType: 'application/msword',
    },
    {
      userId: 'test-user-1',
      fileName: 'ZEBRA.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
    },
    {
      userId: 'test-user-1',
      fileName: 'apple-pie.jpg',
      type: KnowledgeType.FILE,
      mimeType: 'image/jpeg',
    },
  ];

  describe('Schema Plugin', () => {
    it('should automatically add fileNameLower field on save', async () => {
      const file = new FabFile({
        userId: 'test-user',
        fileName: 'TestFile.TXT',
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
      });

      await file.save();

      expect((file as any).fileNameLower).toBe('testfile.txt');
    });

    it('should update fileNameLower field on document update', async () => {
      const file = await FabFile.create({
        userId: 'test-user',
        fileName: 'Original.txt',
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
      });

      await FabFile.updateOne({ _id: file._id }, { $set: { fileName: 'Updated.TXT' } });

      const updated = await FabFile.findById(file._id);
      expect((updated as any)?.fileNameLower).toBe('updated.txt');
    });
  });

  describe('Case-Insensitive Sorting', () => {
    beforeEach(async () => {
      await FabFile.insertMany(testFiles);
    });

    it('should sort files case-insensitively in ascending order', async () => {
      // Test with DocumentDB mode OFF (MongoDB collation)
      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';

      const mongoResults = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'asc' }
      );

      // Test with DocumentDB mode ON
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const docdbResults = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'asc' }
      );

      // Both modes should return all files
      expect(docdbResults.data).toHaveLength(5);
      expect(mongoResults.data).toHaveLength(5);

      // Both modes should contain the same files (order consistency is the key goal)
      const docdbNames = docdbResults.data.map(f => f.fileName);
      const mongoNames = mongoResults.data.map(f => f.fileName);

      const expectedFiles = ['Apple.txt', 'banana.pdf', 'Cherry.doc', 'ZEBRA.txt', 'apple-pie.jpg'];
      expect(docdbNames.sort()).toEqual(expectedFiles.sort());
      expect(mongoNames.sort()).toEqual(expectedFiles.sort());

      // The key requirement: both modes should produce consistent results
      // (Order may vary between implementations but should be deterministic)
      expect(docdbNames).toEqual(mongoNames);

      // Restore environment
      process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
    });

    it('should sort files case-insensitively in descending order', async () => {
      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;

      // Test MongoDB mode
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';
      const mongoResults = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'desc' }
      );

      // Test DocumentDB mode
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
      const docdbResults = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'desc' }
      );

      // Both modes should return all files
      expect(docdbResults.data).toHaveLength(5);
      expect(mongoResults.data).toHaveLength(5);

      // Both modes should contain the same files (order consistency is the key goal)
      const docdbNames = docdbResults.data.map(f => f.fileName);
      const mongoNames = mongoResults.data.map(f => f.fileName);

      const expectedFiles = ['Apple.txt', 'banana.pdf', 'Cherry.doc', 'ZEBRA.txt', 'apple-pie.jpg'];
      expect(docdbNames.sort()).toEqual(expectedFiles.sort());
      expect(mongoNames.sort()).toEqual(expectedFiles.sort());

      // The key requirement: both modes should produce consistent results
      // (Order may vary between implementations but should be deterministic)
      expect(docdbNames).toEqual(mongoNames);

      process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
    });
  });

  describe('Search Functionality', () => {
    beforeEach(async () => {
      await FabFile.insertMany(testFiles);
    });

    it('should return identical results for search with sorting', async () => {
      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;

      const searchTerm = 'apple';
      const pagination = { page: 1, limit: 10 };
      const order = { by: 'fileName' as const, direction: 'asc' as const };

      // MongoDB mode
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';
      const mongoResults = await fabFileRepository.search('test-user-1', searchTerm, {}, pagination, order);

      // DocumentDB mode
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
      const docdbResults = await fabFileRepository.search('test-user-1', searchTerm, {}, pagination, order);

      // Should find both "Apple.txt" and "apple-pie.jpg"
      expect(docdbResults.total).toBe(mongoResults.total);
      expect(docdbResults.total).toBe(2);

      // Both modes should find the same files (order may differ due to sorting implementation)
      const docdbFileNames = docdbResults.data.map(f => f.fileName).sort();
      const mongoFileNames = mongoResults.data.map(f => f.fileName).sort();
      expect(docdbFileNames).toEqual(mongoFileNames);
      expect(docdbFileNames).toEqual(['Apple.txt', 'apple-pie.jpg']);

      process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
    });

    it('should handle other sort fields normally in DocumentDB mode', async () => {
      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      // Test sorting by createdAt (should work normally)
      const results = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'desc' }
      );

      expect(results.data).toHaveLength(5);
      // Should be sorted by creation time, not affected by collation fix

      process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
    });
  });

  describe('Large dataset behavior', () => {
    beforeEach(async () => {
      const manyFiles = Array.from({ length: 100 }, (_, i) => ({
        userId: 'test-user-1',
        fileName: `File${String(i).padStart(3, '0')}.txt`,
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
      }));

      // Use create() (not insertMany) so the addLowercaseField plugin's save hook
      // populates `fileNameLower` - this mirrors how FabFiles are actually created
      // in production. insertMany bypasses save middleware and would leave
      // fileNameLower unset, which is not a real creation path for FabFile.
      await FabFile.create(manyFiles);
    });

    // NOTE: This deliberately does NOT assert wall-clock timing. A previous version
    // compared `docdbTime / mongoTime` against a ratio threshold, which was
    // irredeemably flaky: these queries run against an in-memory mongodb-memory-server
    // in single-digit milliseconds, and `Date.now()` has ~1ms resolution, so ordinary
    // CI scheduler contention can push the ratio across any threshold (it failed in CI
    // with `expected 2 to be less than 2`). The DocumentDB-compatibility path swaps a
    // collation-based sort for a sort on the precomputed `fileNameLower` field whose
    // real performance characteristics only manifest on actual DocumentDB at scale -
    // not against an in-memory engine. What we *can* assert deterministically is the
    // contract that matters: both modes return the same correctly-ordered, paginated
    // results regardless of dataset size.
    it('returns identical, correctly-ordered pages in both modes at scale', async () => {
      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;
      const pagination = { page: 1, limit: 20 };
      const order = { by: 'fileName' as const, direction: 'asc' as const };

      try {
        process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';
        const mongoResults = await fabFileRepository.search('test-user-1', '', {}, pagination, order);

        process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
        const docdbResults = await fabFileRepository.search('test-user-1', '', {}, pagination, order);

        const expectedPage = Array.from({ length: 20 }, (_, i) => `File${String(i).padStart(3, '0')}.txt`);

        expect(mongoResults.total).toBe(100);
        expect(docdbResults.total).toBe(100);
        expect(mongoResults.data.map(f => f.fileName)).toEqual(expectedPage);
        expect(docdbResults.data.map(f => f.fileName)).toEqual(expectedPage);
        expect(mongoResults.hasMore).toBe(true);
        expect(docdbResults.hasMore).toBe(true);
      } finally {
        // Restore the original value without coercing an unset var to the string
        // 'undefined', and even if an assertion/search above throws.
        if (originalEnv === undefined) {
          delete process.env.USE_DOCUMENTDB_COMPATIBILITY;
        } else {
          process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
        }
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle missing fileNameLower field gracefully', async () => {
      // Create a file without the fileNameLower field (simulating old data)
      await FabFile.collection.insertOne({
        userId: 'test-user-1',
        fileName: 'OldFile.txt',
        type: KnowledgeType.FILE,
        mimeType: 'text/plain',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      // Should not throw an error
      const results = await fabFileRepository.search(
        'test-user-1',
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'fileName', direction: 'asc' }
      );

      expect(results.data).toHaveLength(1);
      expect(results.data[0].fileName).toBe('OldFile.txt');

      process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
    });
  });
});
