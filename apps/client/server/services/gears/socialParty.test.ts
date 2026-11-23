import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: { userFind: vi.fn(), projectFind: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  User: { find: (...a: unknown[]) => ({ lean: () => mocks.userFind(...a) }) },
  Project: { find: (...a: unknown[]) => ({ limit: () => ({ lean: () => mocks.projectFind(...a) }) }) },
}));
vi.mock('@bike4mind/services', () => ({
  creditService: {
    isRewardPartyBlocked: (party: { isBanned?: boolean; deletedAt?: Date | null; isSynthetic?: boolean }) =>
      !!party.isBanned || !!party.deletedAt || !!party.isSynthetic,
  },
}));

import { hasQualifyingProjectCollaborator, hasQualifyingSocialParty } from './socialParty';

const OWNER = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const THIRD = 'c'.repeat(24);

const owner = { _id: OWNER, emailVerified: true, signupMeta: { ip: '203.0.113.1' } };
const verifiedOther = { _id: OTHER, emailVerified: true, signupMeta: { ip: '198.51.100.7' } };

describe('hasQualifyingSocialParty', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a verified, unblocked account from a different signup IP', async () => {
    mocks.userFind.mockResolvedValue([owner, verifiedOther]);
    await expect(hasQualifyingSocialParty(OWNER, [OTHER])).resolves.toBe(true);
  });

  it('refuses the beneficiary themself without querying', async () => {
    await expect(hasQualifyingSocialParty(OWNER, [OWNER])).resolves.toBe(false);
    expect(mocks.userFind).not.toHaveBeenCalled();
  });

  it('refuses an account without a verified email', async () => {
    mocks.userFind.mockResolvedValue([owner, { ...verifiedOther, emailVerified: false }]);
    await expect(hasQualifyingSocialParty(OWNER, [OTHER])).resolves.toBe(false);
  });

  it('refuses a blocked account', async () => {
    mocks.userFind.mockResolvedValue([owner, { ...verifiedOther, isBanned: true }]);
    await expect(hasQualifyingSocialParty(OWNER, [OTHER])).resolves.toBe(false);
  });

  it('refuses an account that signed up from the beneficiary signup IP', async () => {
    mocks.userFind.mockResolvedValue([owner, { ...verifiedOther, signupMeta: { ip: '203.0.113.1' } }]);
    await expect(hasQualifyingSocialParty(OWNER, [OTHER])).resolves.toBe(false);
  });

  it('skips the IP comparison when the beneficiary has no recorded signup IP', async () => {
    mocks.userFind.mockResolvedValue([{ _id: OWNER, emailVerified: true }, verifiedOther]);
    await expect(hasQualifyingSocialParty(OWNER, [OTHER])).resolves.toBe(true);
  });

  it('ignores ids that are not ObjectIds', async () => {
    await expect(hasQualifyingSocialParty(OWNER, ['not-an-id'])).resolves.toBe(false);
    expect(mocks.userFind).not.toHaveBeenCalled();
  });
});

describe('hasQualifyingProjectCollaborator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes when any collaborator across the owner projects qualifies', async () => {
    mocks.projectFind.mockResolvedValue([{ users: [{ userId: THIRD }] }, { users: [{ userId: OTHER }] }]);
    mocks.userFind.mockResolvedValue([owner, { _id: THIRD, emailVerified: false }, verifiedOther]);
    await expect(hasQualifyingProjectCollaborator(OWNER)).resolves.toBe(true);
    expect(mocks.projectFind).toHaveBeenCalledWith(
      { userId: OWNER, 'users.0': { $exists: true } },
      { 'users.userId': 1 }
    );
  });

  it('fails when the owner has no collaborators', async () => {
    mocks.projectFind.mockResolvedValue([]);
    await expect(hasQualifyingProjectCollaborator(OWNER)).resolves.toBe(false);
  });
});
