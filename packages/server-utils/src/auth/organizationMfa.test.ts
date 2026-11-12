import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ org: vi.fn(), user: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: mocks.org },
}));
vi.mock('@bike4mind/database/auth', () => ({
  userRepository: { findById: mocks.user },
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => !!user.mfa?.totpEnabled },
}));
import { assertOrganizationMfa, organizationMfaIsEnforced, ORGANIZATION_MFA_REQUIRED } from './organizationMfa';
import { withOrganizationMfaContext } from '@bike4mind/db-core';

describe('organization MFA access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.org.mockResolvedValue({ mfaPolicy: { required: true, graceDays: 7, enforceAfter: new Date(0) } });
    mocks.user.mockResolvedValue({ id: 'member', mfa: null });
  });
  it('refuses an unenrolled human principal after grace, regardless of credential type', async () => {
    await expect(assertOrganizationMfa('member', 'org')).rejects.toThrow(ORGANIZATION_MFA_REQUIRED);
  });
  it('admits the same principal after enrollment', async () => {
    mocks.user.mockResolvedValue({ id: 'member', mfa: { totpEnabled: true } });
    await expect(assertOrganizationMfa('member', 'org')).resolves.toBeUndefined();
  });
  it('admits during grace and when policy is disabled', async () => {
    mocks.org.mockResolvedValue({ mfaPolicy: { required: true, enforceAfter: new Date(Date.now() + 60_000) } });
    await expect(assertOrganizationMfa('member', 'org')).resolves.toBeUndefined();
    mocks.org.mockResolvedValue({ mfaPolicy: { required: false } });
    await expect(assertOrganizationMfa('member', 'org')).resolves.toBeUndefined();
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it('does not use a platform-admin bypass', async () => {
    mocks.user.mockResolvedValue({ id: 'admin', isAdmin: true, mfa: null });
    await expect(assertOrganizationMfa('admin', 'org')).rejects.toThrow(ORGANIZATION_MFA_REQUIRED);
  });
  it('admits only a matching service principal inside the trusted key context', async () => {
    mocks.user.mockResolvedValue({
      id: 'service',
      isSystem: true,
      isAdmin: false,
      serviceAccountOrganizationId: 'org',
    });
    await expect(assertOrganizationMfa('service', 'org')).rejects.toThrow(ORGANIZATION_MFA_REQUIRED);
    await withOrganizationMfaContext(
      () => 'service',
      async () => {
        await expect(assertOrganizationMfa('service', 'org')).resolves.toBeUndefined();
        await expect(assertOrganizationMfa('service', 'other')).rejects.toThrow(ORGANIZATION_MFA_REQUIRED);
      },
      () => 'org'
    );
  });
  it('fails closed on missing organizations, users and read failures', async () => {
    mocks.org.mockResolvedValueOnce(null);
    await expect(assertOrganizationMfa('member', 'missing')).rejects.toThrow('Organization not found');
    mocks.user.mockResolvedValueOnce(null);
    await expect(assertOrganizationMfa('member', 'org')).rejects.toThrow(ORGANIZATION_MFA_REQUIRED);
    mocks.org.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(assertOrganizationMfa('member', 'org')).rejects.toThrow('database unavailable');
  });
  it('enforces at the exact deadline and treats malformed required deadlines as due', () => {
    expect(organizationMfaIsEnforced({ required: true, graceDays: 0, enforceAfter: new Date(1000) }, 999)).toBe(false);
    expect(organizationMfaIsEnforced({ required: true, graceDays: 0, enforceAfter: new Date(1000) }, 1000)).toBe(true);
    expect(organizationMfaIsEnforced({ required: true, graceDays: 0, enforceAfter: null })).toBe(true);
    expect(organizationMfaIsEnforced({ required: true, graceDays: 0, enforceAfter: 'invalid' })).toBe(true);
    expect(organizationMfaIsEnforced(undefined)).toBe(false);
  });
});
