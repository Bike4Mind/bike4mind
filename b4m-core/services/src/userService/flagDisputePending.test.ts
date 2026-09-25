import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flagDisputePending, type FlagDisputePendingAdapters } from './flagDisputePending';

function makeAdapters() {
  const deactivateAllByUserId = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockResolvedValue(undefined);
  const adapters: FlagDisputePendingAdapters = {
    db: { users: { update }, userApiKeys: { deactivateAllByUserId } },
  };
  return { adapters, deactivateAllByUserId, update };
}

describe('flagDisputePending', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deactivates keys before writing the flag, and reports the deactivation', async () => {
    const { adapters, deactivateAllByUserId, update } = makeAdapters();

    const result = await flagDisputePending({ id: 'user-1' }, adapters);

    expect(result).toEqual({ deactivatedKeys: true });
    expect(deactivateAllByUserId).toHaveBeenCalledWith('user-1');
    expect(update).toHaveBeenCalledWith({ id: 'user-1', disputePending: true });
    expect(deactivateAllByUserId.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it('does not deactivate or re-report when the user is already dispute-pending', async () => {
    const { adapters, deactivateAllByUserId, update } = makeAdapters();

    const result = await flagDisputePending({ id: 'user-1', disputePending: true }, adapters);

    expect(result).toEqual({ deactivatedKeys: false });
    expect(deactivateAllByUserId).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ id: 'user-1', disputePending: true });
  });

  it('deactivates when the dispute is a new reason on an already-banned account', async () => {
    const { adapters, deactivateAllByUserId } = makeAdapters();

    const result = await flagDisputePending({ id: 'user-1', isBanned: true }, adapters);

    expect(result).toEqual({ deactivatedKeys: true });
    expect(deactivateAllByUserId).toHaveBeenCalledWith('user-1');
  });

  it('leaves the flag unset when deactivation fails, so a retry re-runs the path', async () => {
    const { adapters, deactivateAllByUserId, update } = makeAdapters();
    deactivateAllByUserId.mockRejectedValueOnce(new Error('db down'));

    await expect(flagDisputePending({ id: 'user-1' }, adapters)).rejects.toThrow('db down');

    expect(update).not.toHaveBeenCalled();
  });
});
