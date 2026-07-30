import { leave } from './leave';
import { BadRequestError } from '@bike4mind/utils';
import { IUserDocument } from '@bike4mind/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('organizationService.leave', () => {
  const ORG_ID = 'org-1';

  let db: any;
  const makeUser = (over: Partial<IUserDocument> = {}) =>
    ({ id: 'user-1', organizationId: ORG_ID, groups: [], ...over }) as IUserDocument;

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      organizations: {
        shareable: { findAccessibleById: vi.fn() },
        update: vi.fn(),
      },
      users: { update: vi.fn() },
      groups: { findIdsByOrganization: vi.fn().mockResolvedValue([]) },
    };
  });

  const org = (over: Record<string, unknown> = {}) => ({
    id: ORG_ID,
    userId: 'owner-1',
    users: [{ userId: 'user-1' }, { userId: 'user-2' }],
    userDetails: [{ id: 'user-1' }, { id: 'user-2' }],
    ...over,
  });

  it('purges the org’s group ids from the departing user, keeping other groups', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org());
    db.groups.findIdsByOrganization.mockResolvedValue(['g-org1-a', 'g-org1-b']);
    const user = makeUser({ groups: ['g-org1-a', 'g-org1-b', 'g-otherorg'] });

    await leave(user, { id: ORG_ID }, { db });

    expect(db.groups.findIdsByOrganization).toHaveBeenCalledWith(ORG_ID);
    expect(db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', groups: ['g-otherorg'], organizationId: null })
    );
    expect(user.groups).toEqual(['g-otherorg']);
  });

  it('purges groups even when the left org is NOT the user’s selected org', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org());
    db.groups.findIdsByOrganization.mockResolvedValue(['g-org1-a']);
    const user = makeUser({ organizationId: 'a-different-org', groups: ['g-org1-a', 'keep'] });

    await leave(user, { id: ORG_ID }, { db });

    const patch = db.users.update.mock.calls[0][0];
    expect(patch.groups).toEqual(['keep']);
    expect('organizationId' in patch).toBe(false); // selected org untouched
    expect(user.organizationId).toBe('a-different-org');
  });

  it('clears organizationId when it matches, with no group changes', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org());
    const user = makeUser({ groups: [] });

    await leave(user, { id: ORG_ID }, { db });

    expect(db.users.update).toHaveBeenCalledWith({ id: 'user-1', organizationId: null });
    expect(user.organizationId).toBeNull();
  });

  it('does not touch the user when nothing changed (not selected org, no org groups)', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org());
    db.groups.findIdsByOrganization.mockResolvedValue(['g-org1-a']);
    const user = makeUser({ organizationId: 'other', groups: ['unrelated'] });

    await leave(user, { id: ORG_ID }, { db });

    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('refuses to let the billing owner leave their own org', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org({ userId: 'user-1' }));
    await expect(leave(makeUser(), { id: ORG_ID }, { db })).rejects.toThrow(BadRequestError);
    expect(db.organizations.update).not.toHaveBeenCalled();
  });

  it('removes the user from the org users[] and userDetails[]', async () => {
    db.organizations.shareable.findAccessibleById.mockResolvedValue(org());
    await leave(makeUser(), { id: ORG_ID }, { db });

    const updatedOrg = db.organizations.update.mock.calls[0][0];
    expect(updatedOrg.users).toEqual([{ userId: 'user-2' }]);
    expect(updatedOrg.userDetails).toEqual([{ id: 'user-2' }]);
  });
});
