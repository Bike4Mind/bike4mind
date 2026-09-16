import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

// Which reason the halt branch writes is decided INSIDE the update, by a field that same update
// clears, so a mocked test can only assert that the method was called. These run the real pipeline
// against a real server: the discrimination, the clear, and the idempotence on redelivery.
describe('markConvergencePaused', () => {
  setupMongoTest();

  const makeFile = (fields: Record<string, unknown>) =>
    FabFile.create({
      userId: 'u-paused',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      type: KnowledgeType.FILE,
      filePath: 'report.pdf',
      status: 'complete',
      chunkCount: 0,
      ...fields,
    });

  const reasonOf = async (id: string) => (await FabFile.findById(id).lean())?.chunkStallReason;

  it('a file a producer reset is told its passages were removed', async () => {
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await reasonOf(String(file._id))).toBe('rechunkPaused');
  });

  it('a file the sweep selected is NOT told its passages were removed - it never had any', async () => {
    // The reported bug: the sweep selects on chunkCount 0 and never resets, so `rechunkPaused`'s
    // "its passages were removed" was false, and it is user-visible - `describePipelineStall` renders
    // it to the owner, `knowledge_base_search` reports it to the model, and lake health files the
    // member under `passagesRemoved`.
    const file = await makeFile({ chunkRebuildRequestedAt: null });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await reasonOf(String(file._id))).toBe('unchunkedPaused');
  });

  it('clears the pending-rebuild stamp in the same write, so a file is never both paused and pending', async () => {
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect((await FabFile.findById(file._id).lean())?.chunkRebuildRequestedAt).toBeNull();
  });

  it('is idempotent: a redelivery does not downgrade the accurate reason to the never-chunked one', async () => {
    // The first call nulls the stamp, so a naive re-run would read the file as never-chunked and
    // overwrite a true statement with a false one. SQS redelivers on a 60-minute visibility timeout,
    // so this is an ordinary occurrence, not a corner case.
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));
    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await reasonOf(String(file._id))).toBe('rechunkPaused');
  });

  it("does not preserve the vectorize arm's reason - only chunk-arm reasons count as already-paused", async () => {
    // `vectorizePaused` means "has chunks, no vectors", so the fixture has chunks. The assertion is
    // only that the reason is REPLACED rather than kept by the idempotence guard: no producer routes
    // a chunk-bearing file into the halt branch today, so which chunk-arm reason would be right for
    // that state is not a question this pins.
    const file = await makeFile({
      chunkStallReason: 'vectorizePaused',
      chunkCount: 4,
      chunkRebuildRequestedAt: null,
    });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await reasonOf(String(file._id))).not.toBe('vectorizePaused');
  });

  it('handles a legacy row whose chunkStallReason field is absent, not null', async () => {
    // The #2016 backfill only set the field on rows carrying the legacy prose, so a row predating it
    // has no `chunkStallReason` key at all - and the sweep's `$nin` filter matches an absent field,
    // so these do reach the halt branch. `FabFile.create` cannot produce the state (the schema
    // defaults it to null), hence the raw insert. Both pipeline operators resolve a missing path as
    // falsy rather than erroring, which is what keeps the write off the DLQ; pinned because it is a
    // MongoDB semantic, not something the code says.
    const fabFiles = mongoose.connection.db!.collection('fabfiles');
    const { insertedId } = await fabFiles.insertOne({
      userId: 'u-paused',
      fileName: 'legacy.pdf',
      mimeType: 'application/pdf',
      filePath: 'legacy.pdf',
      status: 'complete',
      chunkCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await fabFileRepository.markConvergencePaused(String(insertedId));

    expect(await reasonOf(String(insertedId))).toBe('unchunkedPaused');
  });

  it('still bumps updatedAt, as the object-form write it replaced did', async () => {
    // A pipeline-form update is not obviously timestamped - mongoose handles the two forms in
    // different code paths. It does: applyTimestampsToUpdate pushes its own `$set` stage onto the
    // pipeline (mongoose 8.x). Pinned because a silent stop would reorder the owner's file list,
    // which sorts on updatedAt.
    const file = await makeFile({ chunkRebuildRequestedAt: null });
    const before = (await FabFile.findById(file._id).lean())?.updatedAt;

    await new Promise(resolve => setTimeout(resolve, 5));
    await fabFileRepository.markConvergencePaused(String(file._id));

    const after = (await FabFile.findById(file._id).lean())?.updatedAt;
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });
});
