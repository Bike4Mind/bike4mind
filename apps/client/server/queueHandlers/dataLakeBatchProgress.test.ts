import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  markTerminalIfActive: vi.fn(),
  findById: vi.fn(),
  recomputeLakeStats: vi.fn(),
  recordBatchCompletion: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { markTerminalIfActive: h.markTerminalIfActive },
  dataLakeRepository: { findById: h.findById },
  fabFileRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { recomputeLakeStats: h.recomputeLakeStats } }));
vi.mock('@server/utils/cloudwatch', () => ({
  recordBatchCompletion: (...a: unknown[]) => h.recordBatchCompletion(...a),
}));

import { finalizeBatchIfComplete } from './dataLakeBatchProgress';

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
