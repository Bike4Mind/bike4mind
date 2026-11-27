import { describe, expect, it, vi } from 'vitest';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import { createStandardGroup } from './createStandardGroup';
import { assignUserToGroup } from './groupMembership';
import { shareGroupProject } from './shareGroupProject';

const owner = { id: 'owner' } as IUserDocument;
const organization = {
  id: 'org',
  userId: owner.id,
  personal: false,
  allowedGroupTypes: [],
  adminUserIds: [],
  users: [{ userId: 'member' }, { userId: 'admin' }],
} as unknown as IOrganizationDocument;

function fixture(overrides: Partial<IOrganizationDocument> = {}) {
  const db = {
    organizations: {
      findById: vi.fn().mockResolvedValue({ ...organization, ...overrides }),
      update: vi.fn(),
    },
    groups: {
      findByOrganization: vi.fn().mockResolvedValue([]),
      createIfMissing: vi.fn(),
      delete: vi.fn(),
      findById: vi.fn().mockResolvedValue({ id: 'group', organizationId: 'org', type: 'team' }),
    },
    users: { removeGroupsFromAllUsers: vi.fn(), addGroupToUser: vi.fn(), removeGroupFromUser: vi.fn() },
    projects: { setOwnedGroupReadAccess: vi.fn().mockResolvedValue(true) },
  };
  return { db };
}

describe('standard group self-service', () => {
  it('lets a new org owner create, assign a member, and share an owned project without staff', async () => {
    const adapters = fixture();
    await createStandardGroup(owner, { organizationId: 'org', type: 'team' }, adapters);
    expect(adapters.db.groups.createIfMissing).toHaveBeenCalledWith({
      name: 'Team',
      description: 'Standard team members.',
      type: 'team',
      organizationId: 'org',
    });
    expect(adapters.db.organizations.update).toHaveBeenCalledWith({ id: 'org', allowedGroupTypes: ['team'] });
    await assignUserToGroup(owner, { organizationId: 'org', groupId: 'group', userId: 'member' }, adapters);
    expect(adapters.db.users.addGroupToUser).toHaveBeenCalledWith('member', 'group');
    await shareGroupProject(
      owner,
      { organizationId: 'org', groupId: 'group', projectId: 'project', enabled: true },
      adapters
    );
    expect(adapters.db.projects.setOwnedGroupReadAccess).toHaveBeenCalledWith('project', 'owner', 'group', true);
  });

  it.each(['sales', 'research', 'customer', 'unknown'])(
    'denies self-service of special or unknown type %s',
    async type => {
      const adapters = fixture();
      await expect(createStandardGroup(owner, { organizationId: 'org', type }, adapters)).rejects.toThrow(
        /staff approval/
      );
      expect(adapters.db.organizations.update).not.toHaveBeenCalled();
      expect(adapters.db.groups.createIfMissing).not.toHaveBeenCalled();
    }
  );

  it('preserves staff grants while enabling the standard type', async () => {
    const adapters = fixture({ allowedGroupTypes: ['sales'] });
    await createStandardGroup(owner, { organizationId: 'org', type: 'team' }, adapters);
    expect(adapters.db.organizations.update).toHaveBeenCalledWith({ id: 'org', allowedGroupTypes: ['sales', 'team'] });
    expect(adapters.db.users.removeGroupsFromAllUsers).not.toHaveBeenCalled();
  });

  it('permits current appointed admins but denies plain members and stale admins', async () => {
    const adapters = fixture({ adminUserIds: ['admin', 'departed'] });
    await createStandardGroup({ id: 'admin' } as IUserDocument, { organizationId: 'org', type: 'team' }, adapters);
    for (const id of ['member', 'departed']) {
      await expect(
        createStandardGroup({ id } as IUserDocument, { organizationId: 'org', type: 'team' }, adapters)
      ).rejects.toThrow(/Not authorized/);
    }
  });

  it('rejects personal and missing organizations', async () => {
    await expect(
      createStandardGroup(owner, { organizationId: 'org', type: 'team' }, fixture({ personal: true }))
    ).rejects.toThrow(/Personal/);
    const adapters = fixture();
    adapters.db.organizations.findById.mockResolvedValue(null);
    await expect(createStandardGroup(owner, { organizationId: 'org', type: 'team' }, adapters)).rejects.toThrow(
      /not found/
    );
  });

  it('does not duplicate a live standard group on retry', async () => {
    const adapters = fixture({ allowedGroupTypes: ['team'] });
    adapters.db.groups.findByOrganization.mockResolvedValue([{ type: 'team' }]);
    await createStandardGroup(owner, { organizationId: 'org', type: 'team' }, adapters);
    expect(adapters.db.groups.createIfMissing).not.toHaveBeenCalled();
  });
});

describe('group project sharing authorization', () => {
  const params = { organizationId: 'org', groupId: 'group', projectId: 'project', enabled: true };

  it('denies plain members and groups from another organization', async () => {
    const adapters = fixture();
    await expect(shareGroupProject({ id: 'member' } as IUserDocument, params, adapters)).rejects.toThrow(
      /Not authorized/
    );
    adapters.db.groups.findById.mockResolvedValue({ id: 'group', organizationId: 'other' });
    await expect(shareGroupProject(owner, params, adapters)).rejects.toThrow('Group not found');
    expect(adapters.db.projects.setOwnedGroupReadAccess).not.toHaveBeenCalled();
  });

  it('returns not found when the project is not owned or is deleted', async () => {
    const adapters = fixture();
    adapters.db.projects.setOwnedGroupReadAccess.mockResolvedValue(false);
    await expect(shareGroupProject(owner, params, adapters)).rejects.toThrow('Owned project not found');
  });

  it('allows the owner to revoke access', async () => {
    const adapters = fixture();
    await shareGroupProject(owner, { ...params, enabled: false }, adapters);
    expect(adapters.db.projects.setOwnedGroupReadAccess).toHaveBeenCalledWith('project', 'owner', 'group', false);
  });
});
