import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SreAccountingContext } from '@bike4mind/services/sreAgentService';

vi.mock('@bike4mind/database', () => ({ platformAttemptRepository: {}, usageEventRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  PlatformAccounting: class {},
  createPlatformAttribution: (configuration: object, execution: object) => ({
    kind: 'platform_operation',
    operation: 'sre_diagnosis',
    ...configuration,
    ...execution,
  }),
}));
vi.mock('@bike4mind/services/sreAgentService', () => ({
  isSreAccountingError: (error: unknown) => error instanceof Error && 'reason' in error,
  SreAccountingError: class extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));

import { createSreQueueAccounting, recoverSreQueueAccounting } from './sreQueueAccounting';

const record = { messageId: 'delivery-one', eventSourceARN: 'test-sre-queue' };
function context() {
  return createSreQueueAccounting(record, Date.now() + 60000, 'test');
}
function withAccounting(accounting: object): SreAccountingContext {
  return { ...context(), accounting } as SreAccountingContext;
}

describe('SRE queue accounting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps identity stable on redelivery and separates queues and new jobs', () => {
    expect(context().attribution).toEqual(context().attribution);
    expect(
      createSreQueueAccounting({ ...record, messageId: 'delivery-two' }, Date.now(), 'test').attribution.executionId
    ).not.toBe(context().attribution.executionId);
    expect(
      createSreQueueAccounting({ ...record, eventSourceARN: 'other-queue' }, Date.now(), 'test').attribution.executionId
    ).not.toBe(context().attribution.executionId);
    expect(context().attribution).not.toHaveProperty('userId');
    expect(context().attribution.logicalJobId).not.toContain(record.eventSourceARN);
  });

  it('rejects missing queue identity and uses the configured environment', () => {
    expect(() => createSreQueueAccounting({ ...record, messageId: '' }, Date.now(), 'test')).toThrow();
    expect(createSreQueueAccounting(record, Date.now(), 'production').attribution.environment).toBe('production');
    expect(createSreQueueAccounting(record, Date.now(), 'preview-example').attribution.environment).toBe('development');
  });

  it('settles an original receipt before a duplicate can complete without a provider send', async () => {
    const state = { receipt: 'usage_known', providerSends: 0 };
    const recover = vi.fn(async () => {
      state.receipt = 'recorded';
      return { recorded: 1, unresolved: 0, failed: [] };
    });
    const diagnostics = vi.fn(async () => ({
      total: state.receipt === 'recorded' ? 0 : 1,
      byState: { registered: 0 },
    }));
    const ctx = withAccounting({ recover, diagnostics });
    await recoverSreQueueAccounting(ctx);
    expect(state).toEqual({ receipt: 'recorded', providerSends: 0 });
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ executionId: ctx.attribution.executionId }));
    expect(diagnostics).toHaveBeenCalledWith({ limit: 1, executionId: ctx.attribution.executionId });
  });

  it.each(['dispatched', 'usage_known', 'unresolved'])('blocks acknowledgment with %s diagnostics', async () => {
    const ctx = withAccounting({
      recover: vi.fn().mockResolvedValue({ recorded: 0, unresolved: 0, failed: [] }),
      diagnostics: vi.fn().mockResolvedValue({ total: 1, byState: { registered: 0 } }),
    });
    await expect(recoverSreQueueAccounting(ctx)).rejects.toThrow('recovery_pending');
  });

  it('finishes later pages after a poisoned attempt but does not acknowledge the affected execution', async () => {
    const recover = vi
      .fn()
      .mockResolvedValueOnce({
        recorded: 0,
        unresolved: 0,
        failed: [{ providerCallId: 'a', code: 'conflict' }],
        nextCursor: 'a',
      })
      .mockResolvedValueOnce({ recorded: 1, unresolved: 0, failed: [] });
    const ctx = withAccounting({
      recover,
      diagnostics: vi.fn().mockResolvedValue({ total: 1, byState: { registered: 0 } }),
    });
    await expect(recoverSreQueueAccounting(ctx)).rejects.toThrow('recovery_pending');
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls[1][0]).toMatchObject({
      afterProviderCallId: 'a',
      executionId: ctx.attribution.executionId,
    });
  });

  it('leaves a different execution unaffected by an unrelated poisoned attempt', async () => {
    const ctx = withAccounting({
      recover: vi.fn(async ({ executionId }) =>
        executionId === 'unrelated'
          ? { recorded: 0, unresolved: 0, failed: [{ providerCallId: 'bad', code: 'conflict' }] }
          : { recorded: 0, unresolved: 0, failed: [] }
      ),
      diagnostics: vi.fn().mockResolvedValue({ total: 0, byState: { registered: 0 } }),
    });
    await expect(recoverSreQueueAccounting(ctx)).resolves.toBeUndefined();
  });

  it('wraps batch fetch failures and stops at the persistence deadline', async () => {
    const recover = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(recoverSreQueueAccounting(withAccounting({ recover }))).rejects.toThrow('recovery_failed');
    recover.mockClear();
    const ctx = { ...withAccounting({ recover }), deadlineAt: Date.now() };
    await expect(recoverSreQueueAccounting(ctx)).rejects.toThrow('recovery_deadline');
    expect(recover).not.toHaveBeenCalled();
  });
});

it('allows an original live registered intent to reach the atomic first-dispatch claim', async () => {
  await expect(
    recoverSreQueueAccounting(
      withAccounting({
        recover: vi.fn().mockResolvedValue({ recorded: 0, unresolved: 0, failed: [] }),
        diagnostics: vi.fn().mockResolvedValue({ total: 1, byState: { registered: 1 } }),
      })
    )
  ).resolves.toBeUndefined();
});
