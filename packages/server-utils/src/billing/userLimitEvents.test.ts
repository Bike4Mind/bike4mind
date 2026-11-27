import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  record: vi.fn(),
  isPaidPlanRefusal: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ userLimitEventRepository: { record: m.record } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: m.warn } }));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  isModelRequiresSubscriptionError: m.isPaidPlanRefusal,
}));

import { recordPaidPlanRefusal, recordUserLimitEvent } from './userLimitEvents';

beforeEach(() => {
  vi.clearAllMocks();
  m.record.mockResolvedValue(undefined);
});

describe('recordUserLimitEvent', () => {
  it('logs and swallows a failed write', async () => {
    m.record.mockRejectedValue(new Error('db down'));
    await expect(recordUserLimitEvent({ userId: 'u1', kind: 'balance_debt' })).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalledWith(
      '[USER_LIMIT_EVENT] failed to record limit hit',
      expect.objectContaining({ kind: 'balance_debt', error: 'db down' })
    );
  });
});

describe('recordPaidPlanRefusal', () => {
  it('records the paid-plan refusal with its model', async () => {
    m.isPaidPlanRefusal.mockReturnValue(true);
    await recordPaidPlanRefusal('u1', 'opus', new Error('paid plan required'));
    expect(m.record).toHaveBeenCalledWith({ userId: 'u1', kind: 'model_requires_paid_plan', model: 'opus' });
  });

  it('ignores any other admission refusal', async () => {
    m.isPaidPlanRefusal.mockReturnValue(false);
    await recordPaidPlanRefusal('u1', 'opus', new Error('model unavailable'));
    expect(m.record).not.toHaveBeenCalled();
  });

  it('never throws when classifying the refusal fails', async () => {
    m.isPaidPlanRefusal.mockImplementation(() => {
      throw new Error('classifier missing');
    });
    await expect(recordPaidPlanRefusal('u1', 'opus', new Error('x'))).resolves.toBeUndefined();
    expect(m.record).not.toHaveBeenCalled();
    expect(m.warn).toHaveBeenCalled();
  });
});
