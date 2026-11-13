import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Permission } from '@bike4mind/common';
const db = vi.hoisted(() => ({ findById: vi.fn(), findMembershipOrgIds: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: db }));
import { assertLibraryAccess } from './libraryAccess';

describe('organization library access', () => {
  beforeEach(() => {
    db.findById.mockResolvedValue({
      id: 'org',
      userId: 'owner',
      adminUserIds: ['manager'],
      users: [
        { userId: 'manager', permissions: [Permission.read] },
        { userId: 'member', permissions: [Permission.read] },
      ],
    });
    db.findMembershipOrgIds.mockResolvedValue(['org']);
  });
  it('allows ordinary member reads but denies admin mutations', async () => {
    await expect(assertLibraryAccess({ id: 'member' }, 'org')).resolves.toBeTruthy();
    await expect(assertLibraryAccess({ id: 'member' }, 'org', true)).rejects.toThrow('Only organization admins');
  });
  it.each(['owner', 'manager'])('allows %s to manage the library', async id => {
    await expect(assertLibraryAccess({ id }, 'org', true)).resolves.toBeTruthy();
  });
  it('denies cross-org access and departed authors even with a stale admin appointment', async () => {
    db.findMembershipOrgIds.mockResolvedValue(['another-org']);
    await expect(assertLibraryAccess({ id: 'manager' }, 'org')).rejects.toThrow('Organization not found');
    await expect(assertLibraryAccess({ id: 'manager' }, 'org', true)).rejects.toThrow('Organization not found');
  });
  it('does not require the original author to remain a member', async () => {
    await expect(assertLibraryAccess({ id: 'member' }, 'org')).resolves.toBeTruthy();
    expect(db.findMembershipOrgIds).toHaveBeenCalledWith('member');
  });
});
