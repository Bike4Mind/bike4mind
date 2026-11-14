import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfaEnrollmentEvents, type IUserDocument } from '@bike4mind/common';

const { mockReadEnforceMfa, mockLogEvent } = vi.hoisted(() => ({
  mockReadEnforceMfa: vi.fn(),
  mockLogEvent: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  mfaService: {
    isMfaEnforcementExempt: (user: IUserDocument) => user.isPersona === true,
    userHasMFAConfigured: (user: IUserDocument) => !!user.mfa?.totpEnabled,
  },
}));
vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', () => ({
  readEnforceMfa: (...a: unknown[]) => mockReadEnforceMfa(...a),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

import { forcedEnrollmentSurface, recordForcedEnrollmentStep, recordMfaEnrollmentEvent } from './mfaEnrollmentFunnel';

const unenrolled = { id: 'u1', mfa: null } as unknown as IUserDocument;
const enrolled = { id: 'u2', mfa: { totpEnabled: true } } as unknown as IUserDocument;
const logger = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockReadEnforceMfa.mockResolvedValue(true);
  mockLogEvent.mockResolvedValue(undefined);
});

describe('forcedEnrollmentSurface', () => {
  it('is the sign-in modal for a pending token without a factor, without reading the setting', async () => {
    expect(await forcedEnrollmentSurface(unenrolled, { mfaPending: true })).toBe('signin');
    expect(mockReadEnforceMfa).not.toHaveBeenCalled();
  });

  it('is the enforcement screen for a full session owing enrollment, through the cached setting', async () => {
    expect(await forcedEnrollmentSurface(unenrolled, {})).toBe('session');
    expect(mockReadEnforceMfa).toHaveBeenCalledWith({ skipCache: false });
  });

  it('is not forced when enforcement is off (voluntary setup from the profile)', async () => {
    mockReadEnforceMfa.mockResolvedValue(false);
    expect(await forcedEnrollmentSurface(unenrolled, {})).toBeNull();
  });

  it('is not forced for a user who already has a factor, or an impersonating admin', async () => {
    expect(await forcedEnrollmentSurface(enrolled, { mfaPending: true })).toBeNull();
    expect(await forcedEnrollmentSurface(unenrolled, { impersonatedBy: 'admin', mfaPending: true })).toBeNull();
  });
});

describe('recordForcedEnrollmentStep', () => {
  it('records the step with the surface and the sign-in it started from', async () => {
    const req = { logger, user: { mfaPending: true, mfaSignIn: { strategy: 'google', createdVia: 'oauth' } } };

    expect(await recordForcedEnrollmentStep(req as never, unenrolled, MfaEnrollmentEvents.SHOWN)).toBe(true);
    expect(mockLogEvent).toHaveBeenCalledExactlyOnceWith({
      userId: 'u1',
      type: MfaEnrollmentEvents.SHOWN,
      metadata: { surface: 'signin', source: 'oauth', strategy: 'google' },
    });
  });

  it('records a session-surface step without a source', async () => {
    await recordForcedEnrollmentStep({ logger, user: {} } as never, unenrolled, MfaEnrollmentEvents.ABANDONED);
    expect(mockLogEvent.mock.calls[0][0]).toEqual({
      userId: 'u1',
      type: MfaEnrollmentEvents.ABANDONED,
      metadata: { surface: 'session' },
    });
  });

  it('records nothing outside forced enrollment', async () => {
    mockReadEnforceMfa.mockResolvedValue(false);
    expect(await recordForcedEnrollmentStep({ logger, user: {} } as never, unenrolled, MfaEnrollmentEvents.SHOWN)).toBe(
      false
    );
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('never throws when the setting read fails', async () => {
    mockReadEnforceMfa.mockRejectedValue(new Error('db down'));
    expect(
      await recordForcedEnrollmentStep({ logger, user: {} } as never, unenrolled, MfaEnrollmentEvents.COMPLETED)
    ).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('recordMfaEnrollmentEvent', () => {
  it('never throws when the write fails', async () => {
    mockLogEvent.mockRejectedValue(new Error('write failed'));
    await expect(
      recordMfaEnrollmentEvent('u1', MfaEnrollmentEvents.REQUIRED, { surface: 'signin' }, logger)
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
