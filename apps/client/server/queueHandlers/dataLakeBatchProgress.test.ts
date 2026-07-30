import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  markTerminalIfActive: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  findById: vi.fn(),
  recomputeLakeStats: vi.fn(),
  recordBatchCompletion: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: {
    markTerminalIfActive: h.markTerminalIfActive,
    setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive,
  },
  dataLakeRepository: { findById: h.findById },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { recomputeLakeStats: h.recomputeLakeStats } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordBatchCompletion: (...a: unknown[]) => h.recordBatchCompletion(...a),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
vi.mock('sst', () => ({ Resource: { dataLakeTaxonomyQueue: { url: 'http://sqs.example/taxonomy' } } }));

import { finalizeBatchIfComplete, enqueueTaxonomyAnalysisIfWanted } from './dataLakeBatchProgress';

const logger = { error: vi.fn() };
// A batch at its completion threshold (vectorized+failed+skipped >= total).
const batch = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'b1',
    dataLakeId: 'lake1',
    totalFiles: 2,
    vectorizedFiles: 2,
    failedFiles: 0,
    skippedFiles: 0,
    ...overrides,
  }) as never;

describe('finalizeBatchIfComplete - batch-completion metric parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.markTerminalIfActive.mockResolvedValue(batch());
    h.findById.mockResolvedValue({ id: 'lake1', datalakeTag: 'datalake:x' });
    h.recordBatchCompletion.mockResolvedValue(undefined); // real emitter returns a Promise
    h.recomputeLakeStats.mockResolvedValue(undefined);
  });

  it('records a clean completion when no files failed', async () => {
    await finalizeBatchIfComplete(batch(), logger as never);
    expect(h.markTerminalIfActive).toHaveBeenCalledWith('b1', 'completed');
    expect(h.recordBatchCompletion).toHaveBeenCalledWith('completed');
  });

  it('records an errored completion when a file failed', async () => {
    h.markTerminalIfActive.mockResolvedValue(batch({ failedFiles: 1 }));
    await finalizeBatchIfComplete(batch({ failedFiles: 1, vectorizedFiles: 1 }), logger as never);
    expect(h.markTerminalIfActive).toHaveBeenCalledWith('b1', 'completed_with_errors');
    expect(h.recordBatchCompletion).toHaveBeenCalledWith('completed_with_errors');
  });

  it('does not record when the batch has not reached the completion threshold', async () => {
    await finalizeBatchIfComplete(batch({ vectorizedFiles: 1 }), logger as never);
    expect(h.markTerminalIfActive).not.toHaveBeenCalled();
    expect(h.recordBatchCompletion).not.toHaveBeenCalled();
  });

  it('does not record when another handler already finalized (guard lost)', async () => {
    h.markTerminalIfActive.mockResolvedValue(null);
    await finalizeBatchIfComplete(batch(), logger as never);
    expect(h.recordBatchCompletion).not.toHaveBeenCalled();
  });
});

/**
 * Deliberately NOT gated on ingest completion - called from upload-complete.ts right
 * after the browser upload phase ends, and as a reconciler backstop, neither of which cares
 * whether chunk/vectorize have finished.
 */
describe('enqueueTaxonomyAnalysisIfWanted - guarded, ingest-independent enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.setTaxonomyStatusIfActive.mockResolvedValue(batch({ taxonomyStatus: 'queued' }));
    h.sendToQueue.mockResolvedValue('msg-id');
  });

  it('no-ops for a null batch or one that never opted in', async () => {
    await enqueueTaxonomyAnalysisIfWanted(null, logger as never);
    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: false }), logger as never);
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('claims the taxonomy phase and enqueues, regardless of chunk/vectorize progress', async () => {
    // vectorizedFiles is nowhere near totalFiles - would never pass finalizeBatchIfComplete's
    // own threshold, proving this function truly does not depend on it.
    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true, vectorizedFiles: 0 }), logger as never);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['none'], 'queued', {
      taxonomyStartedAt: expect.any(Date),
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs.example/taxonomy', {
      batchId: 'b1',
      dataLakeId: 'lake1',
      userId: undefined,
    });
  });

  it('does not enqueue when the guarded claim is lost (already queued/analyzing/etc.)', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue(null);
    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true }), logger as never);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the queue send fails (never blocks the caller)', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    await expect(
      enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true }), logger as never)
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
