// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendToQueue: vi.fn(),
  settleQueuedRun: vi.fn(),
  recordResearchRunOutcome: vi.fn(),
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/database', () => ({
  dataLakeResearchRunRepository: { settleQueuedRun: h.settleQueuedRun },
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeResearchService: { recordResearchRunOutcome: h.recordResearchRunOutcome },
}));

import { queueResearchRun } from './queueResearchRun';

const LAKE = { id: 'lake-oid-1', createdByUserId: 'user-1', organizationId: null };
const RUN = { id: 'run-1', dataLakeId: 'lake-oid-1', totals: { searchHits: 0 }, levers: { query: 'coastal erosion' } };
const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.settleQueuedRun.mockResolvedValue(true);
  h.recordResearchRunOutcome.mockResolvedValue(undefined);
});

describe('queueResearchRun', () => {
  it('sends the run to the queue and resolves quietly on success', async () => {
    h.sendToQueue.mockResolvedValue(undefined);

    await queueResearchRun(RUN as never, LAKE as never, 'https://sqs.example/research', logger);

    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.example/research', {
      runId: 'run-1',
      dataLakeId: 'lake-oid-1',
    });
    expect(h.settleQueuedRun).not.toHaveBeenCalled();
  });

  it('settles the row failed and records the outcome when the enqueue itself fails', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs is down'));

    await expect(queueResearchRun(RUN as never, LAKE as never, 'https://sqs.example/research', logger)).rejects.toThrow(
      'sqs is down'
    );

    expect(h.settleQueuedRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        spentMicroUsd: 0,
        error: expect.stringMatching(/could not be queued/i),
      })
    );
    expect(h.recordResearchRunOutcome).toHaveBeenCalledWith(
      LAKE,
      'coastal erosion',
      'failed',
      'run-1',
      expect.anything()
    );
  });

  // The send can reject after the message actually landed (an ack lost to a timeout). If the
  // executor already claimed the run in that window, settleQueuedRun's queued-only filter makes
  // the settle a no-op (it returns false) - recording an outcome here too would contradict the
  // executor's own runLakeResearch.ts outcome.
  it('skips the outcome record when settleQueuedRun reports the run was already settled elsewhere', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs is down'));
    h.settleQueuedRun.mockResolvedValue(false);

    await expect(queueResearchRun(RUN as never, LAKE as never, 'https://sqs.example/research', logger)).rejects.toThrow(
      'sqs is down'
    );

    expect(h.recordResearchRunOutcome).not.toHaveBeenCalled();
  });

  it('still rethrows the enqueue error even when the outcome write itself fails', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs is down'));
    h.recordResearchRunOutcome.mockRejectedValue(new Error('replica set stepped down'));

    await expect(queueResearchRun(RUN as never, LAKE as never, 'https://sqs.example/research', logger)).rejects.toThrow(
      'sqs is down'
    );
  });

  // A rejected settle leaves ownership unknown: the write may have landed, or the executor may hold
  // the row. Recording a failed outcome on that guess could contradict the run's real one.
  it('skips the outcome record when settleQueuedRun itself rejects, since ownership is unknown', async () => {
    h.sendToQueue.mockRejectedValue(new Error('sqs is down'));
    h.settleQueuedRun.mockRejectedValue(new Error('replica set stepped down'));

    await expect(queueResearchRun(RUN as never, LAKE as never, 'https://sqs.example/research', logger)).rejects.toThrow(
      'sqs is down'
    );

    expect(h.recordResearchRunOutcome).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('settle failed'));
  });
});
