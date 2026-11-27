import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({
  isApiKey: false,
  revokeSession: vi.fn(),
  findActiveByUserId: vi.fn(),
  updateLogoutTime: vi.fn(),
  clearSessionCookies: vi.fn(),
  logEvent: vi.fn(),
  logAuthAudit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  authSessionRepository: { findActiveByUserId: h.findActiveByUserId },
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
const reqFor = (user: unknown) => ({ user, logger: { warn: h.warn } }) as unknown as Request;

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

  it('ends the web sessions Desktop opened when the Desktop session signs out', async () => {
    h.revokeSession.mockResolvedValueOnce({ sid: 'sid-1', clientId: 'b4m-desktop' });
    h.findActiveByUserId.mockResolvedValueOnce([
      { sid: 'web-handoff', createdVia: 'desktop-handoff' },
      { sid: 'web-other', createdVia: 'otc' },
    ]);
    await signOutBrowserSession(reqFor({ id: 'user-1', sid: 'sid-1' }), res);
    expect(h.findActiveByUserId).toHaveBeenCalledWith('user-1');
    expect(h.revokeSession.mock.calls.map(call => call[0])).toEqual(['sid-1', 'web-handoff']);
  });

  it('keeps revoking and still audits when one handoff revoke fails', async () => {
    h.revokeSession
      .mockResolvedValueOnce({ sid: 'sid-1', clientId: 'b4m-desktop' })
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(null);
    h.findActiveByUserId.mockResolvedValueOnce([
      { sid: 'web-handoff-1', createdVia: 'desktop-handoff' },
      { sid: 'web-handoff-2', createdVia: 'desktop-handoff' },
    ]);
    const req = reqFor({ id: 'user-1', sid: 'sid-1' });
    await signOutBrowserSession(req, res);
    expect(h.revokeSession.mock.calls.map(call => call[0])).toEqual(['sid-1', 'web-handoff-1', 'web-handoff-2']);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.logAuthAudit).toHaveBeenCalledWith(req, { userId: 'user-1', event: 'logout' });
  });

  it('still audits when the handoff session lookup fails', async () => {
    h.revokeSession.mockResolvedValueOnce({ sid: 'sid-1', clientId: 'b4m-desktop' });
    h.findActiveByUserId.mockRejectedValueOnce(new Error('db down'));
    const req = reqFor({ id: 'user-1', sid: 'sid-1' });
    await signOutBrowserSession(req, res);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.logAuthAudit).toHaveBeenCalledWith(req, { userId: 'user-1', event: 'logout' });
  });

  it('leaves other sessions alone when a web session signs out', async () => {
    h.revokeSession.mockResolvedValueOnce({ sid: 'sid-1', clientId: null });
    await signOutBrowserSession(reqFor({ id: 'user-1', sid: 'sid-1' }), res);
    expect(h.findActiveByUserId).not.toHaveBeenCalled();
    expect(h.revokeSession).toHaveBeenCalledTimes(1);
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
