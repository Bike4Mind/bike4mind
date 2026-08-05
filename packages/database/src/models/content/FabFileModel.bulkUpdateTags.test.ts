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
        expectedTags: [{ name: 'acme:legal', strength: 1 }],
      },
      { id: b.id, tags: [{ name: 'acme:finance', strength: 0.8 }], expectedTags: [] },
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

  it('skips a file whose tags changed since expectedTags was read, instead of clobbering the concurrent change', async () => {
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags: [{ name: 'acme:legal', strength: 1 }],
    });

    // Simulates a concurrent writer (e.g. a direct tag edit) landing after this caller's read.
    await fabFileRepository.update({
      id: a.id,
      tags: [
        { name: 'acme:legal', strength: 1 },
        { name: 'user:added', strength: 1 },
      ],
    });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      {
        id: a.id,
        tags: [
          { name: 'acme:legal', strength: 1 },
          { name: 'acme:type:contract', strength: 0.9 },
        ],
        expectedTags: [{ name: 'acme:legal', strength: 1 }], // stale - no longer matches stored tags
      },
    ]);

    expect(modifiedCount).toBe(0);
    const fresh = await fabFileRepository.findById(a.id);
    // The concurrent writer's tag survives untouched - not overwritten by the stale merge.
    expect(fresh?.tags?.map(t => t.name).sort()).toEqual(['acme:legal', 'user:added']);
  });

  it('applies the write when expectedTags matches, alongside a sibling op that is skipped', async () => {
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

    // Only `a` drifts from its snapshot; `b` stays untouched, so its op should still apply.
    await fabFileRepository.update({ id: a.id, tags: [{ name: 'user:added', strength: 1 }] });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      {
        id: a.id,
        tags: [
          { name: 'acme:legal', strength: 1 },
          { name: 'acme:type:contract', strength: 0.9 },
        ],
        expectedTags: [{ name: 'acme:legal', strength: 1 }],
      },
      { id: b.id, tags: [{ name: 'acme:finance', strength: 0.8 }], expectedTags: [] },
    ]);

    expect(modifiedCount).toBe(1);
    const [freshA, freshB] = await Promise.all([fabFileRepository.findById(a.id), fabFileRepository.findById(b.id)]);
    expect(freshA?.tags?.map(t => t.name)).toEqual(['user:added']); // untouched by the skipped op
    expect(freshB?.tags?.map(t => t.name)).toEqual(['acme:finance']); // applied normally
  });

  // Legacy rows can store "no tags" as a missing/null field rather than `[]` (see the
  // $ifNull guards in dedupeTagByUserId) - a caller's `file.tags ?? []` read collapses all
  // three to `[]` before it ever becomes expectedTags, so the write-side filter has to treat
  // them as equivalent too, or these files could never receive tags again.
  it('applies the write when tags is a missing field, not just [], for an empty expectedTags snapshot', async () => {
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags: [],
    });
    // Simulates a legacy row: strip the field entirely, bypassing the schema default.
    await FabFile.updateOne({ _id: a._id }, { $unset: { tags: '' } });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      { id: a.id, tags: [{ name: 'acme:legal', strength: 1 }], expectedTags: [] },
    ]);

    expect(modifiedCount).toBe(1);
    const fresh = await fabFileRepository.findById(a.id);
    expect(fresh?.tags?.map(t => t.name)).toEqual(['acme:legal']);
  });

  it('applies the write when tags is explicitly null, not just [], for an empty expectedTags snapshot', async () => {
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags: [],
    });
    await FabFile.updateOne({ _id: a._id }, { $set: { tags: null } });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      { id: a.id, tags: [{ name: 'acme:legal', strength: 1 }], expectedTags: [] },
    ]);

    expect(modifiedCount).toBe(1);
    const fresh = await fabFileRepository.findById(a.id);
    expect(fresh?.tags?.map(t => t.name)).toEqual(['acme:legal']);
  });
});
