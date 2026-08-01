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

// Bulk counterpart to `update`, used by applyTaxonomySuggestions so a batch with many
// files writes its resolved tags in one round trip instead of one findOneAndUpdate per file.
describe('FabFileRepository.bulkUpdateTags', () => {
  const userId = 'u-bulk';

  it('writes each file its own distinct tags array in one call', async () => {
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags: [{ name: 'acme:legal', strength: 1 }],
    });
    const b = await FabFile.create({
      userId,
      fileName: 'b.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'b.txt',
      tags: [],
    });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      {
        id: a.id,
        tags: [
          { name: 'acme:legal', strength: 1 },
          { name: 'acme:type:contract', strength: 0.9 },
        ],
      },
      { id: b.id, tags: [{ name: 'acme:finance', strength: 0.8 }] },
    ]);

    expect(modifiedCount).toBe(2);
    const [freshA, freshB] = await Promise.all([fabFileRepository.findById(a.id), fabFileRepository.findById(b.id)]);
    expect(freshA?.tags?.map(t => t.name).sort()).toEqual(['acme:legal', 'acme:type:contract']);
    expect(freshB?.tags?.map(t => t.name)).toEqual(['acme:finance']);
  });

  it('is a no-op for an empty update list', async () => {
    const modifiedCount = await fabFileRepository.bulkUpdateTags([]);
    expect(modifiedCount).toBe(0);
  });
});
