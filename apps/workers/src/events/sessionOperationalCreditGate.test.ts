import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  checkCredits: vi.fn(),
}));

vi.mock('@server/utils/sessionOperationalCreditPreflight', () => ({
  checkSessionOperationalCredits: h.checkCredits,
}));

import { payerCanFundSessionOperation } from './sessionOperationalCreditGate';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const call = () =>
  payerCanFundSessionOperation({
    payerId: 'payer-1',
    operation: 'session tagging',
    logger: logger as unknown as Logger,
  });

describe('payerCanFundSessionOperation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns true and checks one operation for the payer when the pre-flight allows it', async () => {
    h.checkCredits.mockResolvedValue({ allowed: true });

    await expect(call()).resolves.toBe(true);

    expect(h.checkCredits).toHaveBeenCalledExactlyOnceWith({
      userId: 'payer-1',
      operationCount: 1,
      operation: 'session tagging',
      logger,
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('forwards the model resolver so a free non-operations model can waive the refusal', async () => {
    h.checkCredits.mockResolvedValue({ allowed: true });
    const resolveModelInfo = vi.fn();

    await payerCanFundSessionOperation({
      payerId: 'payer-1',
      operation: 'memento extraction',
      resolveModelInfo,
      logger: logger as unknown as Logger,
    });

    expect(h.checkCredits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 'payer-1', operation: 'memento extraction', resolveModelInfo })
    );
  });

  it('returns false and logs the skip when the pre-flight refuses', async () => {
    h.checkCredits.mockResolvedValue({ allowed: false, reason: 'insufficient credits' });

    await expect(call()).resolves.toBe(false);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[SESSION_OP_CREDIT_SKIP]'),
      expect.objectContaining({ payerId: 'payer-1', reason: 'insufficient credits' })
    );
  });

  it('returns false and logs an error when the pre-flight throws', async () => {
    h.checkCredits.mockRejectedValue(new Error('database unavailable'));

    await expect(call()).resolves.toBe(false);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[SESSION_OP_CREDIT_SKIP]'),
      expect.any(Error),
      expect.objectContaining({ payerId: 'payer-1' })
    );
  });
});
