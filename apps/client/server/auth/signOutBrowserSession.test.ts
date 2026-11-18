import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  isApiKey: false,
  revokeSession: vi.fn(),
  updateLogoutTime: vi.fn(),
  clearSessionCookies: vi.fn(),
  logEvent: vi.fn(),
  logAuthAudit: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  authSessionRepository: {},
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  userService: { updateLogoutTime: h.updateLogoutTime },
  authSessionService: { revokeSession: h.revokeSession },
}));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({ clearSessionCookies: h.clearSessionCookies }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => h.isApiKey }));

import { signOutBrowserSession } from './signOutBrowserSession';

const res = {} as Response;
const reqFor = (user: unknown) => ({ user, logger: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  h.isApiKey = false;
});

describe('signOutBrowserSession', () => {
  it('clears cookies, revokes only this sid and audits the logout', async () => {
    const req = reqFor({ id: 'user-1', sid: 'sid-1' });
    await signOutBrowserSession(req, res);
    expect(h.clearSessionCookies).toHaveBeenCalledWith(res);
    expect(h.updateLogoutTime).toHaveBeenCalledWith('user-1', expect.anything());
    expect(h.revokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
    expect(h.logEvent).toHaveBeenCalledWith({ userId: 'user-1', type: expect.any(String) }, expect.anything());
    expect(h.logAuthAudit).toHaveBeenCalledWith(req, { userId: 'user-1', event: 'logout' });
  });

  it('records the relying party on the audit row', async () => {
    const req = reqFor({ id: 'user-1', sid: 'sid-1' });
    await signOutBrowserSession(req, res, { clientId: 'b4m_example_rp_00000000' });
    expect(h.logAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'logout',
      metadata: { clientId: 'b4m_example_rp_00000000' },
    });
  });

  it('skips the revoke for an API-key caller and for a token without a sid', async () => {
    h.isApiKey = true;
    await signOutBrowserSession(reqFor({ id: 'user-1', sid: 'sid-1' }), res);
    h.isApiKey = false;
    await signOutBrowserSession(reqFor({ id: 'user-1' }), res);
    expect(h.revokeSession).not.toHaveBeenCalled();
    expect(h.clearSessionCookies).toHaveBeenCalledTimes(2);
  });

  it('still clears cookies but writes no audit row without a user', async () => {
    await signOutBrowserSession(reqFor(undefined), res);
    expect(h.clearSessionCookies).toHaveBeenCalledWith(res);
    expect(h.revokeSession).not.toHaveBeenCalled();
    expect(h.logAuthAudit).not.toHaveBeenCalled();
  });
});
