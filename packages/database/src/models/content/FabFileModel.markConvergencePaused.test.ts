import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  CONVERGENCE_PAUSED_CHUNK_NOTE,
  CONVERGENCE_PAUSED_NOTE,
  CONVERGENCE_PAUSED_UNCHUNKED_NOTE,
  KnowledgeType,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

// Which marker the halt branch writes is decided INSIDE the update, by a field that same update
// clears, so a mocked test can only assert that some object was passed. These run the real pipeline
// against a real server: the discrimination, the clear, and the idempotence on redelivery.
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('markConvergencePaused', () => {
  const makeFile = async (fields: Record<string, unknown>) =>
    FabFile.create({
      userId: 'u-paused',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      type: KnowledgeType.FILE,
      filePath: 'report.pdf',
      chunkCount: 0,
      ...fields,
    });

  const notesOf = async (id: string) => (await FabFile.findById(id).lean())?.notes;

  it('a file a producer reset is told its passages were removed', async () => {
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await notesOf(String(file._id))).toBe(CONVERGENCE_PAUSED_CHUNK_NOTE);
  });

  it('a file the sweep selected is NOT told its passages were removed - it never had any', async () => {
    // The reported bug: the sweep selects on chunkCount 0 and never resets, so the older marker's
    // "its passages were removed" was false, and it is user-visible (notes is shown to the owner and
    // drives search's partial-results banner).
    const file = await makeFile({ chunkRebuildRequestedAt: null });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await notesOf(String(file._id))).toBe(CONVERGENCE_PAUSED_UNCHUNKED_NOTE);
  });

  it('clears the pending-rebuild stamp in the same write, so a file is never both paused and pending', async () => {
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect((await FabFile.findById(file._id).lean())?.chunkRebuildRequestedAt).toBeNull();
  });

  it('is idempotent: a redelivery does not downgrade the accurate marker to the never-chunked one', async () => {
    // The first call nulls the stamp, so a naive re-run would read the file as never-chunked and
    // overwrite a true statement with a false one. SQS redelivers on a 60-minute visibility timeout,
    // so this is an ordinary occurrence, not a corner case.
    const file = await makeFile({ chunkRebuildRequestedAt: new Date('2026-01-01T00:00:00.000Z') });

    await fabFileRepository.markConvergencePaused(String(file._id));
    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await notesOf(String(file._id))).toBe(CONVERGENCE_PAUSED_CHUNK_NOTE);
  });

  it("replaces the vectorize arm's marker, which describes a different state", async () => {
    // CONVERGENCE_PAUSED_NOTE means "has chunks, no vectors". It is not one of the chunk-arm
    // markers, so it must not be treated as already-marked and preserved.
    const file = await makeFile({ notes: CONVERGENCE_PAUSED_NOTE, chunkRebuildRequestedAt: null });

    await fabFileRepository.markConvergencePaused(String(file._id));

    expect(await notesOf(String(file._id))).toBe(CONVERGENCE_PAUSED_UNCHUNKED_NOTE);
  });
});
