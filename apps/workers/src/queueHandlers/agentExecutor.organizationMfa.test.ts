import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ org: vi.fn(), user: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: mocks.org } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findById: mocks.user } }));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => user.mfa?.totpEnabled === true },
}));
import { assertExecutionOrganizationMfa } from './agentExecutor.organizationMfa';

describe('background execution organization MFA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.org.mockResolvedValue({ mfaPolicy: { required: true, enforceAfter: new Date(0) } });
    mocks.user.mockResolvedValue({ mfa: null });
  });
  it('denies an unenrolled persisted principal after grace', async () => {
    await expect(assertExecutionOrganizationMfa({ id: 'human' }, { organizationId: 'org' })).rejects.toThrow(
      'requires MFA'
    );
  });
  it('admits enrollment and a future grace deadline', async () => {
    mocks.user.mockResolvedValue({ mfa: { totpEnabled: true } });
    await expect(assertExecutionOrganizationMfa({ id: 'human' }, { organizationId: 'org' })).resolves.toBeUndefined();
    mocks.user.mockResolvedValue({ mfa: null });
    mocks.org.mockResolvedValue({ mfaPolicy: { required: true, enforceAfter: new Date(Date.now() + 60_000) } });
    await expect(assertExecutionOrganizationMfa({ id: 'human' }, { organizationId: 'org' })).resolves.toBeUndefined();
  });
  it('leaves personal execution independent of membership and selection pointers', async () => {
    await expect(assertExecutionOrganizationMfa({ id: 'human' }, {})).resolves.toBeUndefined();
    expect(mocks.org).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it('checks explicit org billing even for a personal session', async () => {
    await expect(assertExecutionOrganizationMfa({ id: 'human' }, {}, 'billing-org')).rejects.toThrow('requires MFA');
    expect(mocks.org).toHaveBeenCalledWith('billing-org');
  });
  it('does not admit a service account without a background execution grant', async () => {
    await expect(
      assertExecutionOrganizationMfa(
        { id: 'service', orgServiceAccount: { organizationId: 'org', createdByUserId: 'owner', grants: [] } },
        { organizationId: 'org' }
      )
    ).rejects.toThrow('resource-grant-aware REST');
    expect(mocks.org).not.toHaveBeenCalled();
  });
});
