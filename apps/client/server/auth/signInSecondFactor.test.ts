import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { IUserDocument } from '@bike4mind/common';

const { mockCountByUser, mockSettingsValue, mockTrustedDevicesAllowed, mockConsumeTrustedDevice } = vi.hoisted(() => ({
  mockCountByUser: vi.fn(),
  mockSettingsValue: vi.fn(),
  mockTrustedDevicesAllowed: vi.fn(),
  mockConsumeTrustedDevice: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  passkeyCredentialRepository: { countByUser: mockCountByUser },
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: IUserDocument) => !!user.mfa?.totpEnabled },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (key: string) => mockSettingsValue(key),
}));
vi.mock('@server/auth/trustedDevice', () => ({
  trustedDevicesAllowed: mockTrustedDevicesAllowed,
  consumeTrustedDevice: mockConsumeTrustedDevice,
}));
vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));

import { readEnforceMfa, resolveSecondFactor } from './signInSecondFactor';

const req = { headers: {} };
const enrolled = { id: 'u1', tokenVersion: 3, mfa: { totpEnabled: true } } as unknown as IUserDocument;
const unenrolled = { id: 'u2', tokenVersion: 0, mfa: null } as unknown as IUserDocument;
const device = { id: 'd1', label: 'Laptop', expiresAt: new Date('2030-01-01') };

function decodePending(token: string) {
  return jwt.verify(token, 'test-secret', { algorithms: ['HS256'] }) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingsValue.mockReturnValue(false);
  mockTrustedDevicesAllowed.mockResolvedValue(true);
  mockConsumeTrustedDevice.mockResolvedValue(null);
  mockCountByUser.mockResolvedValue(0);
});

describe('resolveSecondFactor', () => {
  it('challenges an enrolled user with a short-lived mfaPending token', async () => {
    mockCountByUser.mockResolvedValue(2);

    const outcome = await resolveSecondFactor(req, enrolled);

    expect(outcome).toMatchObject({ kind: 'challenge', passkeyAvailable: true });
    const claims = decodePending((outcome as { mfaToken: string }).mfaToken);
    expect(claims).toMatchObject({ id: 'u1', mfaPending: true, tokenVersion: 3 });
    expect(claims.sid).toBeUndefined();
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
  });

  it('lets a live trusted device skip the challenge and reports it', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect(await resolveSecondFactor(req, enrolled)).toEqual({ kind: 'satisfied', trustedDevice: device });
  });

  it('ignores trusted devices when the admin has turned them off', async () => {
    mockTrustedDevicesAllowed.mockResolvedValue(false);
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, enrolled)).kind).toBe('challenge');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('never consults a trusted device when told not to honour one', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, enrolled, { honourTrustedDevice: false })).kind).toBe('challenge');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('requires enrollment from an unenrolled user when MFA is enforced', async () => {
    mockSettingsValue.mockReturnValue(true);

    const outcome = await resolveSecondFactor(req, unenrolled);

    expect(outcome.kind).toBe('enroll');
    expect(decodePending((outcome as { mfaToken: string }).mfaToken)).toMatchObject({ id: 'u2', mfaPending: true });
  });

  it('never lets a trusted device stand in for enrollment', async () => {
    mockSettingsValue.mockReturnValue(true);
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, unenrolled)).kind).toBe('enroll');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('is satisfied for an unenrolled user when MFA is not enforced', async () => {
    expect(await resolveSecondFactor(req, unenrolled)).toEqual({ kind: 'satisfied', trustedDevice: null });
  });
});

describe('readEnforceMfa', () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('maps the schema-parsed value %s to %s', async (value, expected) => {
    mockSettingsValue.mockReturnValue(value);
    expect(await readEnforceMfa()).toBe(expected);
  });
});
