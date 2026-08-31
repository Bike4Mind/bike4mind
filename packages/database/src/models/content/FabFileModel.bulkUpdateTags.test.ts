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

  it('still reports a modification for an identical-value op, because the schema stamps updatedAt', async () => {
    // The load-bearing fact for applyTaxonomySuggestions, pinned at the layer that owns it: an op
    // whose $set writes the value already stored is STILL modified, because FabFileSchema sets
    // `timestamps: true` and Mongoose injects `updatedAt` into every bulkWrite updateOne unless a
    // `timestamps` option says otherwise (bulkUpdateTags passes only `ordered`/`session`).
    //
    // So modifiedCount is NOT a change-detector on this path, and `skipped = updates.length -
    // filesUpdated` only means "lost a CAS race" because no-op merges are filtered out BEFORE the
    // write. Suppressing them is what keeps that arithmetic honest - and what stops a re-apply
    // rewriting updatedAt on every file for nothing, which reshuffles the `updatedAt: -1` tail of
    // the fileName text index and reorders the user's file list.
    //
    // This fails loudly the day someone adds `timestamps: false` here as an obvious churn
    // optimisation, which would silently turn modifiedCount into a change-detector.
    const tags = [{ name: 'acme:legal', strength: 1 }];
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags,
    });
    const before = (await fabFileRepository.findById(a.id))?.updatedAt;

    const modifiedCount = await fabFileRepository.bulkUpdateTags([{ id: a.id, tags, expectedTags: tags }]);

    expect(modifiedCount).toBe(1);
    const after = (await fabFileRepository.findById(a.id))?.updatedAt;
    expect(after?.getTime()).toBeGreaterThan(before!.getTime());
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

  it('does not write tags to a file soft-deleted since expectedTags was read', async () => {
    const a = await FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      tags: [{ name: 'acme:legal', strength: 1 }],
    });
    // Simulates a delete landing after this caller's read, before its write.
    await FabFile.updateOne({ _id: a._id }, { $set: { deletedAt: new Date() } });

    const modifiedCount = await fabFileRepository.bulkUpdateTags([
      {
        id: a.id,
        tags: [
          { name: 'acme:legal', strength: 1 },
          { name: 'acme:type:contract', strength: 0.9 },
        ],
        expectedTags: [{ name: 'acme:legal', strength: 1 }],
      },
    ]);

    expect(modifiedCount).toBe(0);
    // findById excludes soft-deleted docs by default (schema-level `pre('findOne')` guard) -
    // opt in explicitly to inspect the deleted document's persisted state.
    const raw = await FabFile.findOne({ _id: a._id }, null, { includeDeleted: true });
    expect(raw?.tags?.map((t: { name: string }) => t.name)).toEqual(['acme:legal']);
  });
});
