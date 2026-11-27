import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ platformAttemptRepository: {}, usageEventRepository: {} }));

import { PlatformCompletionAccountingError } from '@bike4mind/services';
import { createSecopsTriageAccounting, recoverSecopsTriageAccounting } from './secopsTriageAccounting';

const record = { messageId: 'message-one', eventSourceARN: 'queue:test-one' };
const makeContext = () => createSecopsTriageAccounting(record, Date.now() + 90_000, 'test');

beforeEach(() => vi.restoreAllMocks());

describe('SecOps queue accounting context', () => {
  it('hashes trusted queue identity, separates executions and uses the runtime environment', () => {
    const first = makeContext();
    const again = makeContext();
    const otherQueue = createSecopsTriageAccounting(
      { ...record, eventSourceARN: 'queue:test-two' },
      Date.now() + 90_000,
      'production'
    );
    expect(first.attribution).toEqual(again.attribution);
    expect(first.attribution).toMatchObject({ operation: 'secops_triage', environment: 'test' });
    expect(first.attribution.executionId).toMatch(/^secops-execution-[a-f0-9]{64}$/);
    expect(JSON.stringify(first.attribution)).not.toContain('message-one');
    expect(otherQueue.attribution.executionId).not.toBe(first.attribution.executionId);
    expect(otherQueue.attribution.environment).toBe('production');
  });

  it.each([
    [{ ...record, messageId: '' }, 90_000, 'test'],
    [{ ...record, eventSourceARN: '' }, 90_000, 'test'],
    [record, NaN, 'test'],
    [record, 90_000, ''],
  ])('rejects missing trusted execution context before registration', (identity, deadline, stage) => {
    expect(() => createSecopsTriageAccounting(identity, deadline, stage)).toThrow(PlatformCompletionAccountingError);
  });
});

describe('SecOps accounting recovery', () => {
  function harness() {
    const context = makeContext();
    const recover = vi
      .spyOn(context.accounting, 'recover')
      .mockResolvedValue({ recorded: 0, unresolved: 0, failed: [] });
    const diagnostics = vi.spyOn(context.accounting, 'diagnostics').mockResolvedValue({
      attempts: [],
      total: 0,
      byState: { registered: 0, dispatched: 0, usage_known: 0, unresolved: 0 },
    });
    return { context, recover, diagnostics };
  }

  it('finishes recovery before reporting an execution safe to inspect', async () => {
    const { context, recover, diagnostics } = harness();
    recover.mockResolvedValueOnce({ recorded: 1, unresolved: 0, failed: [], nextCursor: 'next' });
    await recoverSecopsTriageAccounting(context);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionId: context.attribution.executionId, afterProviderCallId: 'next' })
    );
    expect(diagnostics).toHaveBeenCalledOnce();
  });

  it('permits registered-only receipts but blocks dispatched, unresolved or failed recovery', async () => {
    const { context, recover, diagnostics } = harness();
    diagnostics.mockResolvedValueOnce({
      attempts: [],
      total: 1,
      byState: { registered: 1, dispatched: 0, usage_known: 0, unresolved: 0 },
    });
    await recoverSecopsTriageAccounting(context);
    recover.mockResolvedValueOnce({
      recorded: 0,
      unresolved: 0,
      failed: [{ providerCallId: 'call', code: 'lookup_failed' }],
    });
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_pending' });
    diagnostics.mockResolvedValueOnce({
      attempts: [],
      total: 1,
      byState: { registered: 0, dispatched: 1, usage_known: 0, unresolved: 0 },
    });
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_pending' });
  });

  it('allows durable unresolved receipts only for a completed business execution without erasing them', async () => {
    const { context, recover, diagnostics } = harness();
    const pending = {
      attempts: [],
      total: 2,
      byState: { registered: 1, dispatched: 0, usage_known: 0, unresolved: 1 },
    };
    diagnostics.mockResolvedValue(pending);
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_pending' });
    recover.mockResolvedValue({ recorded: 0, unresolved: 1, failed: [] });
    await expect(recoverSecopsTriageAccounting(context, true)).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenLastCalledWith({ limit: 1, executionId: context.attribution.executionId });
  });

  it.each(['dispatched', 'usage_known', 'failed recovery'])(
    'still rejects %s for a completed business execution',
    async state => {
      const { context, recover, diagnostics } = harness();
      diagnostics.mockResolvedValue({
        attempts: [],
        total: 2,
        byState: {
          registered: 0,
          dispatched: state === 'dispatched' ? 1 : 0,
          usage_known: state === 'usage_known' ? 1 : 0,
          unresolved: 1,
        },
      });
      if (state === 'failed recovery')
        recover.mockResolvedValue({
          recorded: 0,
          unresolved: 1,
          failed: [{ providerCallId: 'call', code: 'persistence_pending' }],
        });
      await expect(recoverSecopsTriageAccounting(context, true)).rejects.toMatchObject({ reason: 'recovery_pending' });
    }
  );

  it('does not expose a repository error as an accounting reason', async () => {
    const { context, recover } = harness();
    recover.mockRejectedValueOnce(new Error('private transport detail'));
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_failed' });
  });

  it('bounds recovery by the persistence reserve and rejects a nonadvancing cursor', async () => {
    const { context, recover } = harness();
    context.deadlineAt = Date.now() + 100;
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_deadline' });
    context.deadlineAt = Date.now() + 90_000;
    recover.mockResolvedValue({ recorded: 0, unresolved: 0, failed: [], nextCursor: 'same' });
    await expect(recoverSecopsTriageAccounting(context)).rejects.toMatchObject({ reason: 'recovery_cursor' });
  });
});
