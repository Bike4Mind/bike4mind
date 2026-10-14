import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';

const { mockIssueBrowserSession, mockLogSecondFactorSignIn, mockTrustedDevicesAllowed, mockGrantTrustedDevice } =
  vi.hoisted(() => ({
    mockIssueBrowserSession: vi.fn(),
    mockLogSecondFactorSignIn: vi.fn(),
    mockTrustedDevicesAllowed: vi.fn(),
    mockGrantTrustedDevice: vi.fn(),
  }));

vi.mock('@server/auth/issueSession', () => ({ issueBrowserSession: mockIssueBrowserSession }));
vi.mock('@server/auth/trustedDevice', () => ({
  trustedDevicesAllowed: mockTrustedDevicesAllowed,
  grantTrustedDevice: mockGrantTrustedDevice,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@server/auth/signInSecondFactor', () => ({
  readSignInOrigin: (user: { mfaSignIn?: unknown } | undefined) => user?.mfaSignIn,
  logSecondFactorSignIn: mockLogSecondFactorSignIn,
}));

import { completeMfaLogin } from './completeMfaLogin';

const user = { id: 'u1', tokenVersion: 2 } as unknown as IUserDocument;
const res = {} as Response;

const requestFor = (reqUser: Record<string, unknown>) => ({ user: reqUser, headers: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mockIssueBrowserSession.mockResolvedValue({ accessToken: 'full-access' });
  mockTrustedDevicesAllowed.mockResolvedValue(false);
});

describe('completeMfaLogin', () => {
  it('keeps a break-glass sign-in identifiable and audits it', async () => {
    const origin = { strategy: 'local', createdVia: 'emergency' };
    const req = requestFor({ id: 'u1', mfaSignIn: origin });

    const result = await completeMfaLogin(req, res, user, {});

    expect(result).toEqual({ accessToken: 'full-access', deviceRemembered: false });
    expect(mockIssueBrowserSession).toHaveBeenCalledWith(req, res, 'u1', { createdVia: 'emergency', tokenVersion: 2 });
    expect(mockLogSecondFactorSignIn).toHaveBeenCalledWith(req, 'u1', origin);
  });

  it('attributes any other origin to MFA and audits it', async () => {
    const origin = { strategy: 'google', createdVia: 'oauth' };
    const req = requestFor({ id: 'u1', mfaSignIn: origin });

    await completeMfaLogin(req, res, user, {});

    expect(mockIssueBrowserSession).toHaveBeenCalledWith(req, res, 'u1', { createdVia: 'mfa', tokenVersion: 2 });
    expect(mockLogSecondFactorSignIn).toHaveBeenCalledWith(req, 'u1', origin);
  });

  it('attributes a request with no origin to MFA and writes no sign-in audit', async () => {
    const req = requestFor({ id: 'u1' });

    await completeMfaLogin(req, res, user, {});

    expect(mockIssueBrowserSession).toHaveBeenCalledWith(req, res, 'u1', { createdVia: 'mfa', tokenVersion: 2 });
    expect(mockLogSecondFactorSignIn).not.toHaveBeenCalled();
  });
});
