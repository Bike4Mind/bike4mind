import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ update: vi.fn(), transaction: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { updateOne: h.update },
  withTransaction: h.transaction,
}));
import { withAccountNotPurging } from './withAccountNotPurging';

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation(async (write: () => Promise<unknown>) => write());
  h.update.mockResolvedValue({ matchedCount: 1 });
});

describe('sign-in writes during permanent deletion', () => {
  it('writes the shared user version before inserting authentication data in a transaction', async () => {
    const order: string[] = [];
    h.update.mockImplementation(async () => {
      order.push('user');
      return { matchedCount: 1 };
    });
    const write = vi.fn(async () => {
      order.push('session');
      return 'issued';
    });
    await expect(withAccountNotPurging('user', write)).resolves.toBe('issued');
    expect(order).toEqual(['user', 'session']);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith({ _id: 'user', 'deletion.purgeStartedAt': null }, { $inc: { __v: 1 } });
  });

  it('does not recreate authentication records after purge has started or the user is gone', async () => {
    h.update.mockResolvedValue({ matchedCount: 0 });
    const write = vi.fn();
    await expect(withAccountNotPurging('user', write)).rejects.toThrow('Account deletion is in progress');
    expect(write).not.toHaveBeenCalled();
  });

  it('propagates a failed guard lookup without inserting records', async () => {
    h.update.mockRejectedValue(new Error('database unavailable'));
    const write = vi.fn();
    await expect(withAccountNotPurging('user', write)).rejects.toThrow('database unavailable');
    expect(write).not.toHaveBeenCalled();
  });
});
