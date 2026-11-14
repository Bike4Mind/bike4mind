import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, type AdminRole } from '@bike4mind/common';
import type { AdminRolesDeps } from './adminRoles';
import { createAdminRole, deleteAdminRole, getAdminRole, listAdminRoles, updateAdminRole } from './adminRoles';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const DELEGATE = { id: 'd'.repeat(24), isAdmin: false, adminPermissions: ['settings:manage'] };
const ROLE_ID = 'e'.repeat(24);

const role = (overrides: Partial<AdminRole> = {}): AdminRole => ({
  id: ROLE_ID,
  name: 'Support',
  description: '',
  permissions: ['support:read'],
  createdBy: ADMIN.id,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

let deps: AdminRolesDeps & {
  roles: { [K in keyof AdminRolesDeps['roles']]: ReturnType<typeof vi.fn> };
  memberCounts: ReturnType<typeof vi.fn>;
  removeFromMembers: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  requireStepUp: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  deps = {
    roles: {
      list: vi.fn().mockResolvedValue([role()]),
      findById: vi.fn().mockResolvedValue(role()),
      findByIds: vi.fn(),
      create: vi.fn().mockImplementation(async input => role({ ...input })),
      update: vi.fn().mockImplementation(async (_id, patch) => role(patch)),
      delete: vi.fn().mockResolvedValue(true),
    },
    memberCounts: vi.fn().mockResolvedValue(new Map([[ROLE_ID, 3]])),
    removeFromMembers: vi.fn().mockResolvedValue(0),
    audit: vi.fn().mockResolvedValue(null),
    requireStepUp: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (work: () => Promise<unknown>) => work()),
  };
});

describe('reads', () => {
  it('lists roles with their member counts', async () => {
    await expect(listAdminRoles(deps)).resolves.toEqual([{ ...role(), memberCount: 3 }]);
  });

  it('answers 404 for a missing role', async () => {
    deps.roles.findById.mockResolvedValue(null);
    await expect(getAdminRole(ROLE_ID, deps)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.each([
  ['create', () => createAdminRole(DELEGATE, { name: 'X', description: '', permissions: ['support:read'] }, deps)],
  ['update', () => updateAdminRole(DELEGATE, ROLE_ID, { name: 'X' }, deps)],
  ['delete', () => deleteAdminRole(DELEGATE, ROLE_ID, deps)],
])('%s by a delegate', (_label, run) => {
  it('is refused before any write or audit', async () => {
    await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(deps.roles.create).not.toHaveBeenCalled();
    expect(deps.roles.update).not.toHaveBeenCalled();
    expect(deps.roles.delete).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe('createAdminRole', () => {
  it('stores the creator and audits the permissions', async () => {
    const created = await createAdminRole(
      ADMIN,
      { name: 'Billing', description: '', permissions: ['support:read', 'credits:adjust'] },
      deps
    );

    expect(deps.roles.create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: ADMIN.id }));
    expect(created.memberCount).toBe(0);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.role.created',
        target: { kind: 'adminRole', id: ROLE_ID, displayName: 'Billing' },
        changes: [{ field: 'permissions', before: [], after: ['support:read', 'credits:adjust'] }],
      })
    );
  });

  it('answers 409 for a taken name', async () => {
    deps.roles.create.mockRejectedValue(duplicateKey());
    await expect(
      createAdminRole(ADMIN, { name: 'support', description: '', permissions: ['support:read'] }, deps)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe('updateAdminRole', () => {
  it('audits before/after permissions and the members it affects, after a step-up for a grant', async () => {
    await updateAdminRole(ADMIN, ROLE_ID, { permissions: ['support:read', 'credits:adjust'] }, deps);

    expect(deps.requireStepUp).toHaveBeenCalledOnce();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.role.updated',
        summary: 'granted credits:adjust for 3 members',
        changes: [{ field: 'permissions', before: ['support:read'], after: ['support:read', 'credits:adjust'] }],
        details: { granted: ['credits:adjust'], revoked: [], memberCount: 3 },
      })
    );
  });

  it('needs no step-up to revoke or rename, and still audits', async () => {
    deps.roles.findById.mockResolvedValue(role({ permissions: ['support:read', 'credits:adjust'] }));

    await updateAdminRole(ADMIN, ROLE_ID, { name: 'Support desk', permissions: ['support:read'] }, deps);

    expect(deps.requireStepUp).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          { field: 'name', before: 'Support', after: 'Support desk' },
          { field: 'permissions', before: ['support:read', 'credits:adjust'], after: ['support:read'] },
        ],
        details: { granted: [], revoked: ['credits:adjust'], memberCount: 3 },
      })
    );
  });

  it('refuses the edit without a step-up when it grants', async () => {
    deps.requireStepUp.mockRejectedValue(new ForbiddenError('Re-verify'));
    await expect(
      updateAdminRole(ADMIN, ROLE_ID, { permissions: ['support:read', 'users:delete'] }, deps)
    ).rejects.toThrow('Re-verify');
    expect(deps.roles.update).not.toHaveBeenCalled();
  });

  it('writes no audit entry for a no-op edit', async () => {
    await updateAdminRole(ADMIN, ROLE_ID, { name: 'Support' }, deps);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe('deleteAdminRole', () => {
  it('is refused while the role has members, naming the count', async () => {
    await expect(deleteAdminRole(ADMIN, ROLE_ID, deps)).rejects.toMatchObject({
      additionalInfo: { member_count: 3 },
    });
    expect(deps.roles.delete).not.toHaveBeenCalled();
  });

  it('deletes an unheld role, clears racing assignments and audits', async () => {
    deps.memberCounts.mockResolvedValue(new Map());

    await deleteAdminRole(ADMIN, ROLE_ID, deps);

    expect(deps.roles.delete).toHaveBeenCalledWith(ROLE_ID);
    expect(deps.removeFromMembers).toHaveBeenCalledWith(ROLE_ID);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.role.deleted',
        details: { permissions: ['support:read'], memberCount: 0, removedFromMembers: 0 },
      })
    );
  });

  it('counts members for an uppercase id the same as its stored lowercase form', async () => {
    await expect(deleteAdminRole(ADMIN, ROLE_ID.toUpperCase(), deps)).rejects.toMatchObject({
      additionalInfo: { member_count: 3 },
    });
    expect(deps.roles.delete).not.toHaveBeenCalled();
  });

  it('runs the write and its strict audit in one transaction', async () => {
    deps.memberCounts.mockResolvedValue(new Map());
    deps.transaction.mockImplementation(async (work: () => Promise<unknown>) => {
      const result = await work();
      expect(deps.audit).toHaveBeenCalledOnce();
      return result;
    });

    await deleteAdminRole(ADMIN, ROLE_ID, deps);

    expect(deps.transaction).toHaveBeenCalledOnce();
  });
});
