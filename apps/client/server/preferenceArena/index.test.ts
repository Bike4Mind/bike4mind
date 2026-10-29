import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findById, findOne } = vi.hoisted(() => ({ findById: vi.fn(), findOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  arenaPairRepository: {},
  arenaVoteRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: { findOne },
  User: { findById },
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ creditService: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn() }));

import { loadArenaUser } from './index';

const userQuery = (user: unknown) => ({ select: () => ({ lean: async () => user }) });

describe('loadArenaUser', () => {
  beforeEach(() => {
    findById.mockReset();
    findOne.mockReset();
  });

  it('reads GitHub and work-email proof from the no-card unlock ledger rows', async () => {
    findById.mockReturnValue(userQuery({ emailVerified: true }));
    findOne.mockImplementation(async ({ transactionId }: { transactionId: string }) =>
      transactionId === 'unlock-grant:work_email_verified:u1' ? { transactionId } : null
    );
    expect(await loadArenaUser('u1')).toEqual({ emailVerified: true, noCardUnlocks: ['work_email_verified'] });
    expect(findOne).toHaveBeenCalledWith({ transactionId: 'unlock-grant:github_verified:u1' });
  });

  it('returns null for a missing user', async () => {
    findById.mockReturnValue(userQuery(null));
    findOne.mockResolvedValue(null);
    expect(await loadArenaUser('u1')).toBeNull();
  });
});
