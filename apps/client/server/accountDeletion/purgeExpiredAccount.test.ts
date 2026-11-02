import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOrgs: vi.fn(),
  deleteOrganizationCascade: vi.fn(),
  hardDeleteUser: vi.fn(),
  deleteUserAccount: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findById },
  organizationRepository: { find: mocks.findOrgs },
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: { deleteUserAccount: mocks.deleteUserAccount } }));
vi.mock('@server/organizations/deleteOrganizationCascade', () => ({
  deleteOrganizationCascade: mocks.deleteOrganizationCascade,
}));
vi.mock('@server/services/hardDeleteUser', () => ({ hardDeleteUser: mocks.hardDeleteUser }));

import { purgeExpiredAccount } from './purgeExpiredAccount';

const USER_ID = '665f1c2e8b3a4d0012345678';
const OTHER_ID = '665f1c2e8b3a4d0087654321';
const ORG_ID = '665f1c2e8b3a4d00aaaaaaaa';
const CUTOFF = new Date('2026-03-01T00:00:00.000Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const purge = () => purgeExpiredAccount(USER_ID, { cutoff: CUTOFF, logger });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrgs.mockResolvedValue([]);
  mocks.hardDeleteUser.mockImplementation(async (_id: string, _ctx: unknown, commit: (users: unknown) => unknown) =>
    commit({})
  );
});

describe('purgeExpiredAccount', () => {
  it('hard-deletes an account past its grace period through the shared delete path', async () => {
    const user = { id: USER_ID, deletionRequestedAt: new Date('2026-01-15T00:00:00.000Z') };
    mocks.findById.mockResolvedValue(user);

    await expect(purge()).resolves.toBe('deleted');

    expect(mocks.hardDeleteUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ deletedBy: USER_ID, initiatedBy: 'self' }),
      expect.any(Function)
    );
    expect(mocks.deleteUserAccount).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ db: expect.any(Object) }));
  });

  it('deletes a sole-member organization before the account', async () => {
    const user = { id: USER_ID, deletionRequestedAt: CUTOFF };
    mocks.findById.mockResolvedValue(user);
    mocks.findOrgs.mockResolvedValue([{ id: ORG_ID, users: [{ userId: USER_ID }], adminUserIds: [] }]);

    await expect(purge()).resolves.toBe('deleted');

    expect(mocks.deleteOrganizationCascade).toHaveBeenCalledWith(user, ORG_ID, { logger });
    expect(mocks.deleteOrganizationCascade.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hardDeleteUser.mock.invocationCallOrder[0]
    );
  });

  it('leaves the account alone when someone joined an owned organization during the grace period', async () => {
    mocks.findById.mockResolvedValue({ id: USER_ID, deletionRequestedAt: CUTOFF });
    mocks.findOrgs.mockResolvedValue([{ id: ORG_ID, users: [{ userId: USER_ID }, { userId: OTHER_ID }] }]);

    await expect(purge()).resolves.toBe('org_has_members');

    expect(mocks.hardDeleteUser).not.toHaveBeenCalled();
    expect(mocks.deleteOrganizationCascade).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(ORG_ID));
  });

  it.each([
    ['already deleted', null],
    ['restored', { id: USER_ID, deletionRequestedAt: null }],
    ['still in its grace period', { id: USER_ID, deletionRequestedAt: new Date('2026-03-01T00:00:01.000Z') }],
  ])('skips an account that is %s', async (_label, user) => {
    mocks.findById.mockResolvedValue(user);
    await expect(purge()).resolves.toBe('not_due');
    expect(mocks.hardDeleteUser).not.toHaveBeenCalled();
  });
});
