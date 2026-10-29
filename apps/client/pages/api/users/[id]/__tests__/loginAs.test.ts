import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockLoginAs, mockIssueSession, mockRecord, mockDeny, mockSetRefreshCookie, mockSetAdminReturnCookie } =
  vi.hoisted(() => ({
    mockLoginAs: vi.fn(),
    mockIssueSession: vi.fn(),
    mockRecord: vi.fn(),
    mockDeny: vi.fn(),
    mockSetRefreshCookie: vi.fn(),
    mockSetAdminReturnCookie: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
const txEvents: string[] = [];
vi.mock('@bike4mind/database', () => ({
  userRepository: {},
  SupportAccess: { create: vi.fn().mockResolvedValue([]) },
  withTransaction: async (fn: () => Promise<unknown>) => {
    txEvents.push('tx:start');
    const result = await fn();
    txEvents.push('tx:end');
    return result;
  },
}));
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
  denySelfAdminAction: (...a: unknown[]) => mockDeny(...a),
}));
vi.mock('@bike4mind/services', () => ({
  adminService: { loginAs: (...a: unknown[]) => mockLoginAs(...a) },
}));
vi.mock('@server/auth/issueSession', () => ({
  issueSessionForRequest: (...a: unknown[]) => mockIssueSession(...a),
}));
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({
  readRefreshCookie: () => 'admin-refresh',
  setRefreshCookie: (...a: unknown[]) => mockSetRefreshCookie(...a),
  setAdminReturnCookie: (...a: unknown[]) => mockSetAdminReturnCookie(...a),
}));

import { ForbiddenError, HTTPError } from '@bike4mind/common';
import { httpErrorToResponse } from '@server/middlewares/errorHandler';
import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../loginAs';

const REASON = 'Reproducing a customer ticket';

const post = (body: Record<string, unknown>, id = 'target1') => {
  const { req, res } = createMocks({ method: 'POST', query: { id }, body });
  (req as any).user = { id: 'admin1', name: 'Admin', email: 'a@example.com', isAdmin: true };
  (req as any).logger = { info: vi.fn() };
  return { req, res };
};

describe('POST /api/users/:id/loginAs - respond() boundary', () => {
  beforeEach(() => {
    txEvents.length = 0;
    mockLoginAs.mockReset().mockResolvedValue({ id: 'target1', name: 'Target', notInSchema: 'x' });
    mockIssueSession
      .mockReset()
      .mockResolvedValue({ accessToken: 'tok', refreshToken: 'target-refresh', sid: 'sid-1' });
    mockRecord.mockReset().mockResolvedValue(null);
    mockSetRefreshCookie.mockReset();
    mockSetAdminReturnCookie.mockReset();
    mockDeny.mockReset().mockImplementation(async () => {
      throw new ForbiddenError('Admins cannot perform this action on their own account.');
    });
  });

  it('returns impersonating, the access token and the target user, stripping an undeclared key', async () => {
    const { req, res } = post({ mfaToken: '123456', reason: REASON });
    await (handler as any)(req, res);

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.impersonating).toBe(true);
    expect(json.accessToken).toBe('tok');
    expect(json.user).toMatchObject({ id: 'target1', name: 'Target' });
    expect(json.user).not.toHaveProperty('notInSchema');
  });

  it.each([
    ['missing', undefined],
    ['too short', ' abc '],
    ['too long', 'x'.repeat(501)],
  ])('answers 400 before logging in as anyone when the reason is %s', async (_label, reason) => {
    const { req, res } = post({ mfaToken: '123456', reason });

    await expect((handler as any)(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockLoginAs).not.toHaveBeenCalled();
    expect(mockIssueSession).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('tells a stale tab to reload when the request carries no reason key', async () => {
    const { req, res } = post({ mfaToken: '123456' });

    const invokeHandler = handler as unknown as (request: typeof req, response: typeof res) => Promise<void>;
    const error = await invokeHandler(req, res).catch((error: unknown) => error);
    if (!(error instanceof HTTPError)) throw error;
    const { status, body } = httpErrorToResponse(error, undefined);

    expect(status).toBe(400);
    expect(body.error).toMatch(/reload/i);
    expect(body.error).toBe(ADMIN_ACTION_REASON_MISSING_MESSAGE);
    expect(mockLoginAs).not.toHaveBeenCalled();
  });

  it('denies impersonating yourself with a 403 and a user.impersonation.denied entry', async () => {
    const { req, res } = post({ mfaToken: '123456', reason: REASON }, 'admin1');

    await expect((handler as any)(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.impersonation.denied', attempted: 'user.impersonation.started' })
    );
    expect(mockLoginAs).not.toHaveBeenCalled();
    expect(mockIssueSession).not.toHaveBeenCalled();
  });

  it('denies a self-impersonation with no reason as a 403, not a 400, and records the denial', async () => {
    const { req, res } = post({ mfaToken: '123456' }, 'admin1');

    await expect((handler as any)(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.impersonation.denied', attempted: 'user.impersonation.started' })
    );
    expect(mockLoginAs).not.toHaveBeenCalled();
  });

  it('issues the session inside the transaction and records user.impersonation.started with the sid and reason', async () => {
    mockIssueSession.mockImplementation(async () => {
      txEvents.push('issue');
      return { accessToken: 'tok', refreshToken: 'target-refresh', sid: 'sid-1' };
    });
    mockRecord.mockImplementation(async () => {
      txEvents.push('record');
      return null;
    });
    const { req, res } = post({ mfaToken: '123456', reason: `  ${REASON}  ` });

    await (handler as any)(req, res);

    expect(txEvents).toEqual(['tx:start', 'issue', 'record', 'tx:end']);
    expect(mockIssueSession).toHaveBeenCalledWith(
      expect.anything(),
      'target1',
      expect.objectContaining({ createdVia: 'impersonation', impersonatedBy: 'admin1' })
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.impersonation.started',
        target: expect.objectContaining({ kind: 'user', id: 'target1' }),
        reason: REASON,
        related: { impersonationSessionId: 'sid-1' },
      })
    );
  });

  it('sets the refresh and admin return cookies only after the commit', async () => {
    mockRecord.mockImplementation(async () => {
      expect(mockSetRefreshCookie).not.toHaveBeenCalled();
      return null;
    });
    const { req, res } = post({ mfaToken: '123456', reason: REASON });

    await (handler as any)(req, res);

    expect(mockSetRefreshCookie).toHaveBeenCalledWith(res, 'target-refresh');
    expect(mockSetAdminReturnCookie).toHaveBeenCalledWith(res, 'admin-refresh');
  });

  it('sets no cookies and fails when the audit write fails', async () => {
    mockRecord.mockRejectedValue(new Error('audit down'));
    const { req, res } = post({ mfaToken: '123456', reason: REASON });

    await expect((handler as any)(req, res)).rejects.toThrow('audit down');
    expect(mockSetRefreshCookie).not.toHaveBeenCalled();
    expect(mockSetAdminReturnCookie).not.toHaveBeenCalled();
  });
});
