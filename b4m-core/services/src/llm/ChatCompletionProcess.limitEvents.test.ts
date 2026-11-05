import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';

type SettlementEventSink = {
  recordSettlementEvent: (
    logger: unknown,
    ownerType: CreditHolderType,
    kind: 'balance_debt' | 'debt_written_off',
    model: string | undefined,
    details: Record<string, unknown>
  ) => void;
};

function buildProcess() {
  const recordLimitEvent = vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  // The options are a wide host-wiring bag; settlement events read only db.recordLimitEvent and the user.
  const process = new ChatCompletionProcess({
    db: { recordLimitEvent },
    logger,
    user: { id: 'user1' },
  } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
  // The method is private and only reached mid-settlement, which has no unit harness.
  const sink = process as unknown as SettlementEventSink;
  return { sink, recordLimitEvent, logger };
}

describe('ChatCompletionProcess settlement limit events', () => {
  it('records a shortfall on the timeline when the user is the credit holder', async () => {
    const { sink, recordLimitEvent, logger } = buildProcess();

    sink.recordSettlementEvent(logger, CreditHolderType.User, 'balance_debt', 'model-a', { debtCredits: 7 });
    await Promise.resolve();

    expect(recordLimitEvent).toHaveBeenCalledTimes(1);
    expect(recordLimitEvent).toHaveBeenCalledWith({
      userId: 'user1',
      kind: 'balance_debt',
      model: 'model-a',
      details: { debtCredits: 7 },
    });
  });

  it('records nothing when an organization is the credit holder', async () => {
    const { sink, recordLimitEvent, logger } = buildProcess();

    sink.recordSettlementEvent(logger, CreditHolderType.Organization, 'debt_written_off', 'model-a', {});
    await Promise.resolve();

    expect(recordLimitEvent).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed record', async () => {
    const { sink, recordLimitEvent, logger } = buildProcess();
    recordLimitEvent.mockRejectedValue(new Error('timeline write failed'));

    sink.recordSettlementEvent(logger, CreditHolderType.User, 'balance_debt', undefined, {});
    await new Promise(resolve => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith('[USER_LIMIT_EVENT] failed to record', expect.any(Object));
  });
});
