import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockLoginAs, mockIssueSession } = vi.hoisted(() => ({
  mockLoginAs: vi.fn(),
  mockIssueSession: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@bike4mind/database', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  adminService: { loginAs: (...a: unknown[]) => mockLoginAs(...a) },
}));
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: (...a: unknown[]) => mockIssueSession(...a),
}));
vi.mock('@server/auth/refreshCookie', () => ({
  readRefreshCookie: () => 'admin-refresh',
  setAdminReturnCookie: vi.fn(),
}));

import handler from '../loginAs';

describe('POST /api/users/:id/loginAs - respond() boundary', () => {
  beforeEach(() => {
    mockLoginAs.mockReset().mockResolvedValue({ id: 'target1', name: 'Target', notInSchema: 'x' });
    mockIssueSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  });

  it('returns impersonating, the access token and the target user, stripping an undeclared key', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'target1' }, body: { mfaToken: '123456' } });
    (req as any).user = { id: 'admin1', name: 'Admin', email: 'a@example.com' };
    (req as any).logger = { info: vi.fn() };
    await (handler as any)(req, res);

    expect(res._getStatusCode()).toBe(200);
    const json = res._getJSONData();
    expect(json.impersonating).toBe(true);
    expect(json.accessToken).toBe('tok');
    expect(json.user).toMatchObject({ id: 'target1', name: 'Target' });
    expect(json.user).not.toHaveProperty('notInSchema');
  });
});
