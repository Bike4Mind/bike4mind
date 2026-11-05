import { beforeEach, describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/spendReconciliation', () => ({ runSpendReconciliation: run }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'selfhost' } }));
import { registerSpendReconciliation } from './spendReconciliation';

function register() {
  const registerDailyUtcTask = vi.fn();
  registerSpendReconciliation({ registerDailyUtcTask });
  const [name, hour, task, opts] = registerDailyUtcTask.mock.calls[0];
  return { name, hour, task: task as () => Promise<void>, opts };
}

describe('self-host spend reconciliation schedule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a daily 06:00 UTC task with no startup run', () => {
    const { name, hour, opts } = register();
    expect([name, hour, opts]).toEqual(['spendReconciliation', 6, undefined]);
  });

  it('rejects when any provider-month failed', async () => {
    run.mockResolvedValue({ reconciled: 1, skipped: 0, failed: 2 });
    await expect(register().task()).rejects.toThrow('Spend reconciliation failed for 2 provider-month(s)');
  });

  it('resolves when every provider is skipped', async () => {
    run.mockResolvedValue({ reconciled: 0, skipped: 2, failed: 0 });
    await expect(register().task()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith({ logger: expect.anything() });
  });
});
