import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

const mockGetSettingsMap = vi.fn();
const mockSettingsValue = vi.fn();
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: IUserDocument) => !!user.mfa?.totpEnabled },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => mockGetSettingsMap(...args),
  getSettingsValue: () => mockSettingsValue(),
}));

import { isMfaEnrollmentOwed, readEnforceMfa } from './mfaEnforcement';

const user = (totpEnabled: boolean) => ({ id: 'u1', mfa: { totpEnabled } }) as unknown as IUserDocument;

beforeEach(() => {
  mockGetSettingsMap.mockReset().mockResolvedValue({});
  mockSettingsValue.mockReset();
});

describe('readEnforceMfa', () => {
  it('bypasses the settings cache by default', async () => {
    await readEnforceMfa();
    expect(mockGetSettingsMap).toHaveBeenCalledWith(expect.anything(), { skipCache: true, names: ['enforceMFA'] });
  });
});

describe('isMfaEnrollmentOwed', () => {
  it('is owed by an unenrolled user while enforcement is on', async () => {
    mockSettingsValue.mockReturnValue(true);
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
