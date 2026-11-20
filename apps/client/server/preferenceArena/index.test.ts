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

  it('reads the account fields and grants no proof from retired unlock ledger rows', async () => {
    findById.mockReturnValue(userQuery({ emailVerified: true }));
    findOne.mockResolvedValue({ transactionId: 'unlock-grant:github_verified:u1' });
    expect(await loadArenaUser('u1')).toEqual({ emailVerified: true });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns null for a missing user', async () => {
    findById.mockReturnValue(userQuery(null));
    findOne.mockResolvedValue(undefined);
    expect(await loadArenaUser('u1')).toBeNull();
  });
});
