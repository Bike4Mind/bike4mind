import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const mockGetSettingsMap = vi.fn();
const mockSettingsValue = vi.fn();
const mockOrgRequires = vi.fn();
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  mfaService: {
    isMfaEnforcementExempt: (user: IUserDocument) => user.isPersona === true,
    userHasMFAConfigured: (user: IUserDocument) => !!user.mfa?.totpEnabled,
  },
}));
vi.mock('./organizationMfa', () => ({
  requiresOrganizationMfaEnrollment: (...args: unknown[]) => mockOrgRequires(...args),
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => mockGetSettingsMap(...args),
  getSettingsValue: (...args: unknown[]) => mockSettingsValue(...args),
}));

import { isMfaEnrollmentOwed, isMfaEnrollmentRequired, readEnforceMfa } from './mfaEnforcement';

// The team-policy lookup is cached per user id, so each test gets ids no other test has used.
let nextUserId = 0;
const user = (totpEnabled: boolean, extra: Partial<IUserDocument> = {}) =>
  ({ id: `u${++nextUserId}`, mfa: { totpEnabled }, ...extra }) as unknown as IUserDocument;

beforeEach(() => {
  mockGetSettingsMap.mockReset().mockResolvedValue({});
  mockSettingsValue.mockReset();
  mockOrgRequires.mockReset().mockResolvedValue(false);
});

describe('readEnforceMfa', () => {
  it('bypasses the settings cache by default', async () => {
    await readEnforceMfa();
    expect(mockGetSettingsMap).toHaveBeenCalledWith(expect.anything(), { skipCache: true, names: ['enforceMFA'] });
  });

  it('binds only a boolean true, not the legacy string', async () => {
    // The stored value may be a boolean or a legacy string; only a real true enables enforcement.
    mockSettingsValue.mockReturnValue('true');
    expect(await readEnforceMfa()).toBe(false);
  });
});

describe('isMfaEnrollmentOwed', () => {
  it('is owed by an unenrolled user while enforcement is on', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect(await isMfaEnrollmentOwed(user(false))).toBe(true);
    expect(mockSettingsValue).toHaveBeenCalledWith('enforceMFA', expect.anything());
  });

  it('is never owed by an admin impersonation session', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect(await isMfaEnrollmentOwed(user(false), { impersonatedBy: 'admin-1' })).toBe(false);
    // Exempt before the settings read, so an impersonating admin never pays for it.
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('is never owed by a test persona, and never reads the setting for one', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect(await isMfaEnrollmentOwed(user(false, { isPersona: true }))).toBe(false);
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('is still owed by an ordinary user, whether isPersona is false or absent', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect(await isMfaEnrollmentOwed(user(false, { isPersona: false }))).toBe(true);
    expect(await isMfaEnrollmentOwed(user(false))).toBe(true);
  });

  it('is not owed while enforcement is off', async () => {
    mockSettingsValue.mockReturnValue(false);
    expect(await isMfaEnrollmentOwed(user(false))).toBe(false);
  });

  it('never reads the setting for an enrolled user', async () => {
    expect(await isMfaEnrollmentOwed(user(true))).toBe(false);
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('reads through the settings cache, since it runs on every request', async () => {
    mockSettingsValue.mockReturnValue(true);
    await isMfaEnrollmentOwed(user(false));
    expect(mockGetSettingsMap).toHaveBeenCalledWith(expect.anything(), { skipCache: false, names: ['enforceMFA'] });
  });
});

describe('isMfaEnrollmentOwed under a team MFA policy', () => {
  beforeEach(() => {
    mockSettingsValue.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is owed once the grace period has passed', async () => {
    mockOrgRequires.mockResolvedValue(true);
    const member = user(false);
    expect(await isMfaEnrollmentOwed(member)).toBe(true);
    expect(mockOrgRequires).toHaveBeenCalledWith(member, expect.any(Date));
  });

  it('is not owed while the grace period is still running, nor by a user in no team', async () => {
    // requiresOrganizationMfaEnrollment answers false for both; its own suite covers why.
    expect(await isMfaEnrollmentOwed(user(false))).toBe(false);
  });

  it('is never owed by an enrolled member, and never looks the policy up', async () => {
    mockOrgRequires.mockResolvedValue(true);
    expect(await isMfaEnrollmentOwed(user(true))).toBe(false);
    expect(mockOrgRequires).not.toHaveBeenCalled();
  });

  it('is owed by an unenrolled platform admin, as at sign-in', async () => {
    mockOrgRequires.mockResolvedValue(true);
    expect(await isMfaEnrollmentOwed(user(false, { isAdmin: true }))).toBe(true);
  });

  it('exempts an impersonation session and a test persona without a lookup', async () => {
    mockOrgRequires.mockResolvedValue(true);
    expect(await isMfaEnrollmentOwed(user(false), { impersonatedBy: 'admin-1' })).toBe(false);
    expect(await isMfaEnrollmentOwed(user(false, { isPersona: true }))).toBe(false);
    expect(mockOrgRequires).not.toHaveBeenCalled();
  });

  it('skips the lookup when enforceMFA already requires enrollment', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect(await isMfaEnrollmentOwed(user(false))).toBe(true);
    expect(mockOrgRequires).not.toHaveBeenCalled();
  });

  it('looks the policy up at most once a minute per user', async () => {
    vi.useFakeTimers();
    const member = user(false);
    expect(await isMfaEnrollmentOwed(member)).toBe(false);
    mockOrgRequires.mockResolvedValue(true);
    expect(await isMfaEnrollmentOwed(member)).toBe(false);
    expect(mockOrgRequires).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    expect(await isMfaEnrollmentOwed(member)).toBe(true);
    expect(mockOrgRequires).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the lookup fails', async () => {
    mockOrgRequires.mockRejectedValue(new Error('db down'));
    await expect(isMfaEnrollmentOwed(user(false))).rejects.toThrow('db down');
  });
});

describe('isMfaEnrollmentRequired', () => {
  it('is true for enforceMFA or a binding team policy, regardless of enrollment', async () => {
    mockSettingsValue.mockReturnValue(false);
    mockOrgRequires.mockResolvedValue(true);
    expect(await isMfaEnrollmentRequired(user(true))).toBe(true);
    mockOrgRequires.mockResolvedValue(false);
    expect(await isMfaEnrollmentRequired(user(true))).toBe(false);
  });
});
