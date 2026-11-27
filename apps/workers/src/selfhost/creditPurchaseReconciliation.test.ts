import { beforeEach, describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/creditPurchaseReconciliation', () => ({ runCreditPurchaseReconciliation: run }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'selfhost' } }));
import { registerCreditPurchaseReconciliation } from './creditPurchaseReconciliation';

function register() {
  const registerDailyUtcTask = vi.fn();
  registerCreditPurchaseReconciliation({ registerDailyUtcTask });
  const [name, hour, task, opts] = registerDailyUtcTask.mock.calls[0];
  return { name, hour, task: task as () => Promise<void>, opts };
}

describe('self-host credit purchase reconciliation schedule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a daily 07:00 UTC task with no startup run', () => {
    const { name, hour, opts } = register();
    expect([name, hour, opts]).toEqual(['creditPurchaseReconciliation', 7, undefined]);
  });

  it('runs for the self-host stage with the CloudWatch metric off', async () => {
    run.mockResolvedValue({ checked: 1, ungranted: [], ownerDeleted: 0, truncated: false, skipped: false });
    await register().task();
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.any(Date), { stage: 'selfhost', emitMetrics: false });
  });

  it('does not throw on ungranted purchases or when skipped', async () => {
    run.mockResolvedValueOnce({ checked: 1, ungranted: [{}], ownerDeleted: 0, truncated: false, skipped: false });
    await expect(register().task()).resolves.toBeUndefined();
    run.mockResolvedValueOnce({ checked: 0, ungranted: [], ownerDeleted: 0, truncated: false, skipped: true });
    await expect(register().task()).resolves.toBeUndefined();
  });
});
