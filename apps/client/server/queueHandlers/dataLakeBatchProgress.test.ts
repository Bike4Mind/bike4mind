import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  markTerminalIfActive: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
  findById: vi.fn(),
  recomputeLakeStats: vi.fn(),
  recordBatchCompletion: vi.fn(),
  recordTaxonomyDailyCapExceeded: vi.fn(),
  sendToQueue: vi.fn(),
  sendToClient: vi.fn(),
  tryIncrementWithinLimitFixedWindow: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: {
    markTerminalIfActive: h.markTerminalIfActive,
    setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive,
  },
  dataLakeRepository: { findById: h.findById },
  fabFileRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrementWithinLimitFixedWindow },
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { recomputeLakeStats: h.recomputeLakeStats } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordBatchCompletion: (...a: unknown[]) => h.recordBatchCompletion(...a),
  recordTaxonomyDailyCapExceeded: (...a: unknown[]) => h.recordTaxonomyDailyCapExceeded(...a),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => h.sendToClient(...a) }));
vi.mock('sst', () => ({
  Resource: {
    dataLakeTaxonomyQueue: { url: 'http://sqs.example/taxonomy' },
    websocket: { managementEndpoint: 'http://ws.example' },
  },
}));

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

  it('does not enqueue taxonomy analysis either when this handler loses the terminal-transition race', async () => {
    h.markTerminalIfActive.mockResolvedValue(null);
    await finalizeBatchIfComplete(batch({ wantsTaxonomy: true }), logger as never);
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  // Backstop for upload-complete.ts's own call: if that request never lands (network blip,
  // tab closed) but chunk/vectorize finish here on their own, this is the only other
  // guaranteed-to-run path left that can still enqueue taxonomy analysis for the batch.
  it('also enqueues taxonomy analysis for the winning batch when it opted in', async () => {
    h.markTerminalIfActive.mockResolvedValue(batch({ wantsTaxonomy: true, userId: 'u1' }));
    h.setTaxonomyStatusIfActive.mockResolvedValue(batch({ taxonomyStatus: 'queued' }));
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
    h.sendToQueue.mockResolvedValue('msg-id');

    await finalizeBatchIfComplete(batch(), logger as never);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['none'], 'queued', {
      taxonomyStartedAt: expect.any(Date),
    });
    expect(h.sendToQueue).toHaveBeenCalled();
  });

  it('does not enqueue taxonomy analysis for a batch that never opted in', async () => {
    h.markTerminalIfActive.mockResolvedValue(batch({ wantsTaxonomy: false }));
    await finalizeBatchIfComplete(batch(), logger as never);
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
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
    h.sendToClient.mockResolvedValue(undefined);
    h.recordTaxonomyDailyCapExceeded.mockResolvedValue(undefined);
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
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

  it('does not enqueue when the guarded claim is lost (already queued/analyzing/etc.), and never even checks the cap', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue(null);
    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true }), logger as never);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(h.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the queue send fails (never blocks the caller)', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    await expect(
      enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true }), logger as never)
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  // The automatic path is the primary OpenAI-cost driver (fires once per opted-in upload),
  // unlike the manual re-analyze endpoint which was already capped - this closes that gap.
  // Claims BEFORE checking the cap so an over-cap batch still lands on a real terminal status
  // ('failed', recoverable via Re-analyze) instead of being silently stranded at 'none' forever.
  it('claims first, then reverts to a real failed status (with a real message) when the daily cap is exceeded', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 50, expiresAt: new Date() });
    h.setTaxonomyStatusIfActive
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'queued' })) // the claim
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'failed' })); // the revert-to-failed

    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true, userId: 'u1' }), logger as never);

    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(1, 'b1', ['none'], 'queued', {
      taxonomyStartedAt: expect.any(Date),
    });
    expect(h.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:u1:data-lakes/reanalyze-taxonomy',
      50,
      24 * 60 * 60 * 1000
    );
    expect(h.recordTaxonomyDailyCapExceeded).toHaveBeenCalledTimes(1);
    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(2, 'b1', ['queued'], 'failed', {
      taxonomyError: 'Daily AI tag-suggestion limit reached - try again tomorrow',
    });
    // Notified live (mirrors analyzeBatchTaxonomy's fail()), since this transition won the race.
    expect(h.sendToClient).toHaveBeenCalledWith('u1', 'http://ws.example', {
      action: 'data_lake_batch_progress',
      batchId: 'b1',
      taxonomyStatus: 'failed',
    });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('does not notify when the revert-to-failed write loses its own guard (something else already resolved it)', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 50, expiresAt: new Date() });
    h.setTaxonomyStatusIfActive
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'queued' })) // the claim
      .mockResolvedValueOnce(null); // revert-to-failed guard lost

    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true, userId: 'u1' }), logger as never);

    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('swallows a failed revert-to-failed write instead of throwing (never blocks the caller)', async () => {
    h.tryIncrementWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 50, expiresAt: new Date() });
    h.setTaxonomyStatusIfActive
      .mockResolvedValueOnce(batch({ taxonomyStatus: 'queued' })) // the claim
      .mockRejectedValueOnce(new Error('mongo down')); // revert-to-failed write itself errors

    await expect(
      enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true, userId: 'u1' }), logger as never)
    ).resolves.toBeUndefined();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('shares its rate-limit bucket with the manual reanalyze endpoint (same key format)', async () => {
    await enqueueTaxonomyAnalysisIfWanted(batch({ wantsTaxonomy: true, userId: 'u2' }), logger as never);

    expect(h.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:u2:data-lakes/reanalyze-taxonomy',
      expect.any(Number),
      expect.any(Number)
    );
  });
});
