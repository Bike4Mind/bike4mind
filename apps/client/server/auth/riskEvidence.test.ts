import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claimRiskEvidenceRefresh = vi.fn();
const releaseRiskEvidenceRefresh = vi.fn();
vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {},
  authEventRepository: {},
  usageEventRepository: {},
  userApiKeyRepository: {},
  userAuthAuditLogRepository: {},
  userRepository: {
    claimRiskEvidenceRefresh: (...args: unknown[]) => claimRiskEvidenceRefresh(...args),
    releaseRiskEvidenceRefresh: (...args: unknown[]) => releaseRiskEvidenceRefresh(...args),
  },
}));

const sendToQueue = vi.fn();
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => sendToQueue(...args),
}));

vi.mock('sst', () => ({ Resource: { riskEvidenceQueue: { url: 'https://queue.test/risk' } } }));

import { requestRiskEvidenceRefresh } from './riskEvidence';

const logger = { warn: vi.fn() };

describe('requestRiskEvidenceRefresh', () => {
  beforeEach(() => {
    claimRiskEvidenceRefresh.mockReset().mockResolvedValue(true);
    releaseRiskEvidenceRefresh.mockReset().mockResolvedValue(undefined);
    sendToQueue.mockReset().mockResolvedValue(undefined);
    logger.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a claimed refresh to the risk evidence queue with the debounce delay', async () => {
    await expect(requestRiskEvidenceRefresh('user-1', 'login', logger)).resolves.toBe('queued');

    expect(sendToQueue).toHaveBeenCalledWith(
      'https://queue.test/risk',
      expect.objectContaining({ kind: 'refresh', userId: 'user-1', trigger: 'login' }),
      60
    );
    expect(releaseRiskEvidenceRefresh).not.toHaveBeenCalled();
  });

  it('gives up on a send that never resolves, and releases the claim', async () => {
    vi.useFakeTimers();
    sendToQueue.mockReturnValue(new Promise(() => undefined));

    const outcome = requestRiskEvidenceRefresh('user-1', 'login', logger);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toBe('failed');
    expect(releaseRiskEvidenceRefresh).toHaveBeenCalledWith('user-1', claimRiskEvidenceRefresh.mock.calls[0][1].now);
    expect(logger.warn).toHaveBeenCalledWith(
      'Risk evidence refresh not queued',
      expect.objectContaining({ userId: 'user-1', error: 'risk evidence enqueue timed out' })
    );
  });

  it('returns failed without throwing when the send rejects', async () => {
    sendToQueue.mockRejectedValueOnce(new Error('sqs down'));

    await expect(requestRiskEvidenceRefresh('user-1', 'login', logger)).resolves.toBe('failed');
    expect(releaseRiskEvidenceRefresh).toHaveBeenCalledWith('user-1', claimRiskEvidenceRefresh.mock.calls[0][1].now);
  });
});
