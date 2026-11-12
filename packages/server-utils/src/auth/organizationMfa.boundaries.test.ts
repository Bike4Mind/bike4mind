import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ org: vi.fn(), user: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: mocks.org, shareable: { findAccessibleById: mocks.org } },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.org, shareable: { findAccessibleById: mocks.org } },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findById: mocks.user } }));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => !!user.mfa?.totpEnabled },
}));

import { verifyOrgAccess, verifyOrgMembership, verifyOrgOwner, resolveBillingOrgId } from '../utils/orgAccess';
import { resolveActiveOrg } from '../utils/resolveActiveOrg';

const id = '650000000000000000000abc';
const member = { id: 'member', isAdmin: false, groups: [], organizationId: id } as unknown as IUserDocument;
const owner = { ...member, id: 'owner' };
const org = {
  id,
  userId: 'owner',
  users: [{ userId: 'member', permissions: ['read'] }],
  adminUserIds: [],
  mfaPolicy: { required: true, graceDays: 0, enforceAfter: new Date(0) },
};

describe('organization MFA authorization boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.org.mockResolvedValue(org);
    mocks.user.mockResolvedValue({ mfa: null });
  });
  it('refuses member, owner, management and explicit billing access after the deadline', async () => {
    await expect(verifyOrgMembership(member, id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyOrgOwner(owner, id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyOrgAccess(owner, id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolveActiveOrg({ user: member }, id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolveBillingOrgId({ user: member }, id)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('admits the same org access after enrollment', async () => {
    mocks.user.mockResolvedValue({ mfa: { totpEnabled: true } });
    await expect(verifyOrgMembership(member, id)).resolves.toEqual(org);
    await expect(verifyOrgOwner(owner, id)).resolves.toEqual(org);
    await expect(resolveActiveOrg({ user: member }, id)).resolves.toBe(id);
  });
  it('preserves explicit personal selection and personal billing without an org lookup', async () => {
    await expect(resolveActiveOrg({ user: member }, null)).resolves.toBeUndefined();
    await expect(resolveBillingOrgId({ user: member }, null)).resolves.toBeNull();
    expect(mocks.org).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it('admits org access while grace remains', async () => {
    mocks.org.mockResolvedValue({
      ...org,
      mfaPolicy: { ...org.mfaPolicy, enforceAfter: new Date(Date.now() + 60_000) },
    });
    await expect(verifyOrgMembership(member, id)).resolves.toBeDefined();
    expect(mocks.user).not.toHaveBeenCalled();
  });
});
