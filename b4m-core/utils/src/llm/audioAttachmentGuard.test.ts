import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { IFabFileDocument, ModelBackend, ModelInfo } from '@bike4mind/common';
import { processFabFilesServer } from './utils';

/**
 * Regression lock for the hard constraint that generated audio is NEVER sent to
 * an LLM (no model accepts audio input). processFabFilesServer is the single
 * chokepoint every chat/agent attachment path funnels through, so the guard is
 * asserted here: an audio FabFile must produce no message content and must not
 * touch storage - even when the model supports vision (the only branch that
 * would otherwise fetch bytes).
 */
describe('processFabFilesServer — audio is never attached to an LLM', () => {
  const embeddingService = {
    getModelInfo: () => ({ contextWindow: 8192, model: 'text-embedding-3-small' }),
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  };
  const embeddingFactory = {
    getDefaultEmbeddingModel: () => 'text-embedding-3-small',
    createEmbeddingService: () => embeddingService,
  } as any;

  const audioFile = {
    id: 'audio-1',
    fileName: 'speech-hello-1234.mp3',
    mimeType: 'audio/mpeg',
    filePath: 'generated-audio/abc.mp3',
    type: 'AUDIO',
    vectorized: false,
    fileSize: 4096,
  } as unknown as IFabFileDocument;

  // A vision-capable model: the ONLY path that would otherwise download bytes.
  const visionModel = { supportsVision: true, backend: ModelBackend.OpenAI, id: 'gpt-4o' } as unknown as ModelInfo;

  it('skips an audio file: no messages, no storage read, no RAG lookup', async () => {
    const storage = {
      download: vi.fn(),
      getSignedUrl: vi.fn(),
    } as any;
    const db = {
      fabfilechunks: { findVectorsByFabFileIds: vi.fn(), countByFabFileId: vi.fn() },
      fabfiles: { update: vi.fn() },
      caches: { get: vi.fn(), set: vi.fn() },
    } as any;

    const result = await processFabFilesServer(
      embeddingFactory,
      [audioFile],
      'please summarize the attachment',
      100_000,
      visionModel,
      async () => {},
      { logger: new Logger({ component: 'audio-guard-test' }), storage, db }
    );

    // Audio yields neither user content nor an error - it is silently skipped.
    expect(result.userMessages).toEqual([]);
    expect(result.errorMessages).toEqual([]);
    // Proof the guard fired at the top: no attempt to fetch or read the bytes,
    // and no RAG/vector lookup. If the guard regresses, audio falls to the
    // non-image branch and at least one of these is exercised.
    expect(storage.download).not.toHaveBeenCalled();
    // Both readers, not just one: the guard proof has to name whatever the cosine path actually
    // calls, or it passes vacuously the next time that reader is swapped.
    expect(db.fabfilechunks.findVectorsByFabFileIds).not.toHaveBeenCalled();
    expect(db.fabfilechunks.countByFabFileId).not.toHaveBeenCalled();
  });
});
