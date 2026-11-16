import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthEvents, MfaEnrollmentEvents, type IUserDocument } from '@bike4mind/common';

const {
  mockCountByUser,
  mockSettingsValue,
  mockTrustedDevicesAllowed,
  mockConsumeTrustedDevice,
  mockGetSettingsMap,
  mockLogEvent,
  mockLogAuthAudit,
  mockRecordMfaEnrollmentEvent,
  mockOrgEnrollment,
} = vi.hoisted(() => ({
  mockOrgEnrollment: vi.fn(),
  mockRecordMfaEnrollmentEvent: vi.fn(),
  mockGetSettingsMap: vi.fn(),
  mockLogEvent: vi.fn(),
  mockLogAuthAudit: vi.fn(),
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
  getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
  getSettingsValue: (key: string) => mockSettingsValue(key),
}));
vi.mock('@server/auth/trustedDevice', () => ({
  trustedDevicesAllowed: mockTrustedDevicesAllowed,
  consumeTrustedDevice: mockConsumeTrustedDevice,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a) }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));
vi.mock('@server/auth/mfaEnrollmentFunnel', () => ({
  recordMfaEnrollmentEvent: (...a: unknown[]) => mockRecordMfaEnrollmentEvent(...a),
}));
vi.mock('./organizationMfa', () => ({ requiresOrganizationMfaEnrollment: mockOrgEnrollment }));

import {
  logSecondFactorSignIn,
  readEnforceMfa,
  readSignInOrigin,
  resolveSecondFactor,
  type SignInOrigin,
} from './signInSecondFactor';

const req = { headers: {} };
const enrolled = { id: 'u1', tokenVersion: 3, mfa: { totpEnabled: true } } as unknown as IUserDocument;
const unenrolled = { id: 'u2', tokenVersion: 0, mfa: null } as unknown as IUserDocument;
const origin: SignInOrigin = { strategy: 'otc', createdVia: 'otc' };
const device = { id: 'd1', label: 'Laptop', expiresAt: new Date('2030-01-01') };

function decodePending(token: string) {
  return jwt.verify(token, 'test-secret', { algorithms: ['HS256'] }) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettingsMap.mockResolvedValue({});
  mockLogEvent.mockResolvedValue(undefined);
  mockLogAuthAudit.mockResolvedValue(undefined);
  mockSettingsValue.mockReturnValue(false);
  mockTrustedDevicesAllowed.mockResolvedValue(true);
  mockConsumeTrustedDevice.mockResolvedValue(null);
  mockCountByUser.mockResolvedValue(0);
  mockOrgEnrollment.mockResolvedValue(false);
});

describe('resolveSecondFactor', () => {
  it('uses the existing setup handoff when an org requires enrollment', async () => {
    mockOrgEnrollment.mockResolvedValue(true);
    const outcome = await resolveSecondFactor(req, unenrolled, { origin });
    expect(outcome.kind).toBe('enroll');
    expect(decodePending((outcome as { mfaToken: string }).mfaToken)).toMatchObject({ id: 'u2', mfaPending: true });
  });

  it('does not consult org policy for an enrolled user', async () => {
    mockOrgEnrollment.mockResolvedValue(true);
    expect((await resolveSecondFactor(req, enrolled, { origin })).kind).toBe('challenge');
    expect(mockOrgEnrollment).not.toHaveBeenCalled();
  });

  it('requires org enrollment for an enterprise sign-in without applying global MFA', async () => {
    mockSettingsValue.mockReturnValue(true);
    expect((await resolveSecondFactor(req, unenrolled, { origin, enterpriseIdp: true })).kind).toBe('satisfied');
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
    mockOrgEnrollment.mockResolvedValue(true);
    expect((await resolveSecondFactor(req, unenrolled, { origin, enterpriseIdp: true })).kind).toBe('enroll');
    expect((await resolveSecondFactor(req, enrolled, { origin, enterpriseIdp: true })).kind).toBe('satisfied');
  });

  it('challenges an enrolled user with a short-lived mfaPending token', async () => {
    mockCountByUser.mockResolvedValue(2);

    const outcome = await resolveSecondFactor(req, enrolled, { origin });

    expect(outcome).toMatchObject({ kind: 'challenge', passkeyAvailable: true });
    const claims = decodePending((outcome as { mfaToken: string }).mfaToken);
    expect(claims).toMatchObject({
      id: 'u1',
      mfaPending: true,
      tokenVersion: 3,
      signInStrategy: 'otc',
      signInVia: 'otc',
    });
    expect(claims.sid).toBeUndefined();
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
  });

  it('lets a live trusted device skip the challenge and reports it', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect(await resolveSecondFactor(req, enrolled, { origin })).toEqual({ kind: 'satisfied', trustedDevice: device });
  });

  it('ignores trusted devices when the admin has turned them off', async () => {
    mockTrustedDevicesAllowed.mockResolvedValue(false);
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, enrolled, { origin })).kind).toBe('challenge');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('never consults a trusted device when told not to honour one', async () => {
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, enrolled, { origin, honourTrustedDevice: false })).kind).toBe('challenge');
    expect(mockRecordMfaEnrollmentEvent).not.toHaveBeenCalled();
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('requires enrollment from an unenrolled user when MFA is enforced', async () => {
    mockSettingsValue.mockReturnValue(true);

    const outcome = await resolveSecondFactor(req, unenrolled, { origin });

    expect(outcome.kind).toBe('enroll');
    expect(decodePending((outcome as { mfaToken: string }).mfaToken)).toMatchObject({
      id: 'u2',
      mfaPending: true,
      signInStrategy: 'otc',
      signInVia: 'otc',
    });
    expect(mockRecordMfaEnrollmentEvent).toHaveBeenCalledExactlyOnceWith('u2', MfaEnrollmentEvents.REQUIRED, {
      surface: 'signin',
      source: 'otc',
      strategy: 'otc',
    });
  });

  it('carries the caller-supplied origin on the token rather than a fixed one', async () => {
    const outcome = await resolveSecondFactor(req, enrolled, {
      origin: { strategy: 'local', createdVia: 'emergency' },
      honourTrustedDevice: false,
    });

    expect(decodePending((outcome as { mfaToken: string }).mfaToken)).toMatchObject({
      signInStrategy: 'local',
      signInVia: 'emergency',
    });
  });

  it('never lets a trusted device stand in for enrollment', async () => {
    mockSettingsValue.mockReturnValue(true);
    mockConsumeTrustedDevice.mockResolvedValue(device);

    expect((await resolveSecondFactor(req, unenrolled, { origin })).kind).toBe('enroll');
    expect(mockConsumeTrustedDevice).not.toHaveBeenCalled();
  });

  it('is satisfied for an unenrolled user when MFA is not enforced', async () => {
    expect(await resolveSecondFactor(req, unenrolled, { origin })).toEqual({ kind: 'satisfied', trustedDevice: null });
    expect(mockRecordMfaEnrollmentEvent).not.toHaveBeenCalled();
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

describe('readEnforceMfa settings read', () => {
  it('bypasses the settings cache and fetches only enforceMFA', async () => {
    await readEnforceMfa();

    expect(mockGetSettingsMap).toHaveBeenCalledWith(expect.anything(), { skipCache: true, names: ['enforceMFA'] });
  });
});

describe('readSignInOrigin', () => {
  it('returns the origin a pending request carries and undefined otherwise', () => {
    expect(readSignInOrigin({ mfaSignIn: origin })).toEqual(origin);
    expect(readSignInOrigin({})).toBeUndefined();
    expect(readSignInOrigin(undefined)).toBeUndefined();
  });
});

describe('logSecondFactorSignIn', () => {
  const signInReq = {
    headers: { 'user-agent': 'UA/1' },
    socket: { remoteAddress: '203.0.113.7' },
    logger: { error: vi.fn() },
  } as unknown as Parameters<typeof logSecondFactorSignIn>[0];

  it('records the LOGIN event with the origin strategy and the login_success audit without a trusted device', async () => {
    await logSecondFactorSignIn(signInReq, 'u1', {
      strategy: 'google' as SignInOrigin['strategy'],
      createdVia: 'oauth',
    });

    expect(mockLogEvent).toHaveBeenCalledWith({
      userId: 'u1',
      type: AuthEvents.LOGIN,
      metadata: { strategy: 'google', ip: '203.0.113.7', userAgent: 'UA/1' },
    });
    expect(mockLogAuthAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAuthAudit).toHaveBeenCalledWith(signInReq, {
      userId: 'u1',
      event: 'login_success',
      strategy: 'google',
      metadata: undefined,
    });
  });

  it('does not throw, and still writes the audit, when the analytics log rejects', async () => {
    mockLogEvent.mockRejectedValue(new Error('analytics down'));

    await expect(logSecondFactorSignIn(signInReq, 'u1', origin)).resolves.toBeUndefined();

    expect(signInReq.logger?.error).toHaveBeenCalled();
    expect(mockLogAuthAudit).toHaveBeenCalledWith(signInReq, expect.objectContaining({ event: 'login_success' }));
  });
});
