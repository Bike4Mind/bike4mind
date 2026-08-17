import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, FabFileChunk, fabFileChunkRepository, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const makeChunk = (fabFileId: string, over: { charLength?: number; vector?: number[] } = {}) =>
  FabFileChunk.create({ fabFileId, text: 't', tokenCount: 1, ...over });

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({ userId: 'u1', fileName, type: KnowledgeType.TEXT, status: 'complete', ...extra });

describe('lake-health rollup primitives (#1666)', () => {
  setupMongoTest();

  it('computeChunkVectorRollup: terminal = vector OR oversized; embedded = vector-bearing only', async () => {
    const contextWindow = 100;
    await makeChunk('f1', { charLength: 100, vector: [0.1, 0.2], tokenCount: 5 }); // vector-bearing
    await makeChunk('f1', { charLength: 200, vector: [0.3, 0.4], tokenCount: 5 }); // vector-bearing
    await makeChunk('f1', { charLength: 999, tokenCount: 500 }); // oversized, no vector: terminal, NOT embedded
    await makeChunk('f1', { charLength: 40, tokenCount: 5 }); // in-window, no vector: neither
    await makeChunk('f2', { charLength: 50, vector: [0.5], tokenCount: 5 });

    expect(await fabFileChunkRepository.computeChunkVectorRollup('f1', contextWindow)).toEqual({
      terminalChunkCount: 3, // 2 vector-bearing + 1 oversized-unembeddable
      embeddedChunkCount: 2, // only vector-bearing
      embeddedCharCount: 300, // 100 + 200
    });
    expect(await fabFileChunkRepository.computeChunkVectorRollup('missing', contextWindow)).toEqual({
      terminalChunkCount: 0,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
    });
  });

  it('computeFileChunkRollups returns all four rollups, max over all chunks, embedded over vector-bearing', async () => {
    await makeChunk('f1', { charLength: 100, vector: [0.1] });
    await makeChunk('f1', { charLength: 4000 }); // largest, but unvectorized
    await makeChunk('f1', { charLength: 300, vector: [0.2] });

    expect(await fabFileChunkRepository.computeFileChunkRollups('f1')).toEqual({
      chunkedCharCount: 4400,
      maxChunkCharLength: 4000,
      embeddedChunkCount: 2,
      embeddedCharCount: 400,
    });
  });

  it('findFileIdsMissingChunkRollups selects chunked files missing maxChunkCharLength, incl. char-only backfilled', async () => {
    const missing = await makeFile('missing.txt', { chunkCount: 2 });
    // #1665 gave chunkedCharCount but not the #1666 rollups - must still be selected:
    const charOnly = await makeFile('char-only.txt', { chunkCount: 2, chunkedCharCount: 500 });
    await makeFile('done.txt', { chunkCount: 2, chunkedCharCount: 500, maxChunkCharLength: 300 });
    await makeFile('chunkless.txt', { chunkCount: 0 });

    const ids = await fabFileRepository.findFileIdsMissingChunkRollups();
    expect(ids).toEqual([String(missing._id), String(charOnly._id)]);

    await fabFileRepository.setChunkRollups(String(missing._id), {
      chunkedCharCount: 400,
      maxChunkCharLength: 250,
      embeddedChunkCount: 2,
      embeddedCharCount: 400,
    });
    expect(await fabFileRepository.findFileIdsMissingChunkRollups()).toEqual([String(charOnly._id)]);
  });

  it('findDataLakeHealthMembers preserves null (unmeasured) and excludes chunkless members', async () => {
    const tag = 'datalake:acme';
    const scope = { datalakeTag: tag, fileTagPrefix: 'acme:', creatorUserId: 'u1' };
    await makeFile('measured.txt', {
      chunkCount: 3,
      vectorizedChunkCount: 3,
      chunkedCharCount: 9000,
      maxChunkCharLength: 3000,
      embeddedChunkCount: 3,
      embeddedCharCount: 9000,
      tags: [{ name: tag, strength: 1 }],
    });
    await makeFile('unmeasured.txt', {
      chunkCount: 5, // legacy: no char rollups
      tags: [{ name: tag, strength: 1 }],
    });
    await makeFile('failed.txt', {
      chunkCount: 4,
      vectorizedChunkCount: 1,
      error: 'embedding provider rejected the request',
      chunkedCharCount: 12000,
      maxChunkCharLength: 3000,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
      tags: [{ name: tag, strength: 1 }],
    });
    await makeFile('chunkless.txt', { chunkCount: 0, tags: [{ name: tag, strength: 1 }] });

    const members = await fabFileRepository.findDataLakeHealthMembers(scope);
    const byName = Object.fromEntries(members.map(m => [m.fileName, m]));

    expect(members).toHaveLength(3); // chunkless excluded
    expect(byName['measured.txt']).toMatchObject({
      vectorizedChunkCount: 3,
      error: null,
      chunkedCharCount: 9000,
      maxChunkCharLength: 3000,
      embeddedChunkCount: 3,
    });
    // The terminal-failure marker is projected so the evaluator can grade a failed file (not hide it).
    expect(byName['failed.txt'].error).toBe('embedding provider rejected the request');
    // Unmeasured file: the #1666 CHAR rollups come back as null, NOT coerced to 0.
    // (vectorizedChunkCount is a pre-existing field defaulting to 0, so it is 0 here, not null - the
    // health evaluator reads that 0 as "vectorization not settled", which is inert for an unmeasured
    // file since its reachable figure is null and P3 is unknown regardless.)
    expect(byName['unmeasured.txt'].vectorizedChunkCount).toBe(0);
    expect(byName['unmeasured.txt'].error).toBeNull();
    expect(byName['unmeasured.txt'].chunkedCharCount).toBeNull();
    expect(byName['unmeasured.txt'].maxChunkCharLength).toBeNull();
    expect(byName['unmeasured.txt'].embeddedChunkCount).toBeNull();
    expect(byName['unmeasured.txt'].embeddedCharCount).toBeNull();
  });
});
