import { describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/accountDeletionSweep', async importOriginal => ({
  ...(await importOriginal<typeof import('@workers/cron/accountDeletionSweep')>()),
  runAccountDeletionSweep: run,
}));

import { registerAccountDeletionSweep } from './accountDeletionSweep';

const register = () => {
  let registered!: { name: string; hour: number; task: () => Promise<void> };
  registerAccountDeletionSweep({
    registerDailyUtcTask: (name, hour, task) => {
      registered = { name, hour, task };
    },
  });
  return registered;
};

describe('self-host account deletion sweep', () => {
  it('registers a daily task at the hosted cron slot, 05:00 UTC', () => {
    expect(register()).toMatchObject({ name: 'accountDeletionSweep', hour: 5 });
  });

  it('resolves when every account succeeds', async () => {
    run.mockResolvedValueOnce({ deleted: 2, not_due: 0, not_found: 0, failed: 0 });
    await expect(register().task()).resolves.toBeUndefined();
  });

  it('rejects when any account failed', async () => {
    run.mockResolvedValueOnce({ deleted: 1, not_due: 0, not_found: 0, failed: 1 });
    await expect(register().task()).rejects.toThrow('1 account(s) failed to delete');
  });
});
