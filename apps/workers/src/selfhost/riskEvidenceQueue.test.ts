import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@workers/queueHandlers/riskEvidence', () => ({ dispatch }));
import { registerRiskEvidenceQueue } from './riskEvidenceQueue';

const logger = { warn: vi.fn() } as unknown as Logger;

describe('registerRiskEvidenceQueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leaves an unconfigured optional queue unregistered', () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerRiskEvidenceQueue(worker, undefined, logger);
    expect(worker.registerQueueHandler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('registers the dispatch handler with batched delivery and the hosted retry budget', () => {
    const worker = { registerQueueHandler: vi.fn() };
    registerRiskEvidenceQueue(worker, 'http://sqs/risk-evidence', logger);
    expect(worker.registerQueueHandler).toHaveBeenCalledWith(
      'riskEvidenceQueue',
      'http://sqs/risk-evidence',
      dispatch,
      {
        batchSize: 10,
        visibilityTimeoutSec: 180,
        maxReceiveCount: 3,
      }
    );
  });
});
