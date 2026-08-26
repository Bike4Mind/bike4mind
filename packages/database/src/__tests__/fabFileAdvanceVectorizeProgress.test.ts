import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { setupMongoTest } from '../__test__/utils';
import { KnowledgeType } from '@bike4mind/common';

/**
 * Real Mongo: the whole point of this method is the filter it runs against stored state, so a
 * mocked repository would assert nothing. Reproduces the multi-message vectorize interleaving -
 * a late message writing the rollup it measured before its peers finished - which an unguarded
 * update leaves stranded below chunkCount with isVectorizing on, invisible to every semantic read.
 */
setupMongoTest();

describe('FabFileRepository.advanceVectorizeProgress', () => {
  const seed = async (fields: Record<string, unknown>): Promise<string> => {
    const doc = await FabFile.create({
      userId: 'vectorize-progress-user',
      fileName: 'seed.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      chunkCount: 10,
      ...fields,
    });
    return doc.id as string;
  };
  const stateOf = async (id: string) => {
    const raw = await FabFile.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    return {
      vectorized: raw?.vectorized,
      vectorizedChunkCount: raw?.vectorizedChunkCount,
      isVectorizing: raw?.isVectorizing,
    };
  };

  beforeEach(async () => {
    await FabFile.deleteMany({});
  });

  it('advances a file that is still partially vectorized', async () => {
    const file = await seed({ vectorized: true, vectorizedChunkCount: 0, isVectorizing: false });

    expect(await fabFileRepository.advanceVectorizeProgress(file, 4)).toBe(true);
    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 4, isVectorizing: true });
  });

  it('is idempotent for a redelivered message that recomputes the same count', async () => {
    const file = await seed({ vectorized: true, vectorizedChunkCount: 4, isVectorizing: true });

    expect(await fabFileRepository.advanceVectorizeProgress(file, 4)).toBe(true);
    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 4, isVectorizing: true });
  });

  it('refuses to regress the count when a peer message already wrote a higher one', async () => {
    const file = await seed({ vectorized: true, vectorizedChunkCount: 9, isVectorizing: true });

    expect(await fabFileRepository.advanceVectorizeProgress(file, 8)).toBe(false);
    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 9, isVectorizing: true });
  });

  it('cannot reopen a file another message already settled - the stranding interleaving', async () => {
    const file = await seed({ vectorized: true, vectorizedChunkCount: 0, isVectorizing: true });

    // Message A measures 8 of 10. Message B then finishes the last batch and stamps terminal.
    const staleRollup = 8;
    await fabFileRepository.update({
      id: file,
      vectorized: true,
      vectorizedChunkCount: 10,
      isVectorizing: false,
      chunkEmbeddingModelStampedAt: new Date(),
    });

    // A's write lands last.
    expect(await fabFileRepository.advanceVectorizeProgress(file, staleRollup)).toBe(false);
    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 10, isVectorizing: false });
  });

  it('converges on the terminal state whichever order the two writes land in', async () => {
    const file = await seed({ vectorized: true, vectorizedChunkCount: 0, isVectorizing: true });

    // Reverse order: the stale partial lands first, the terminal stamp after.
    expect(await fabFileRepository.advanceVectorizeProgress(file, 8)).toBe(true);
    await fabFileRepository.update({
      id: file,
      vectorized: true,
      vectorizedChunkCount: 10,
      isVectorizing: false,
      chunkEmbeddingModelStampedAt: new Date(),
    });

    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 10, isVectorizing: false });
  });

  it('leaves a re-chunked file advanceable again once the stamp is cleared', async () => {
    const file = await seed({
      vectorized: true,
      vectorizedChunkCount: 0,
      isVectorizing: false,
      chunkEmbeddingModelStampedAt: null,
    });

    expect(await fabFileRepository.advanceVectorizeProgress(file, 3)).toBe(true);
    expect(await stateOf(file)).toEqual({ vectorized: true, vectorizedChunkCount: 3, isVectorizing: true });
  });
});
