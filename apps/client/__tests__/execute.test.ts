import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import handler from '@pages/api/admin/tools/execute';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: any) => fn,
  }),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@client/server/tools/adminToolsServer', () => ({
  initializeServerAdminTools: vi.fn(),
  getServerAdminToolService: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ success: true, data: 'test' }),
  })),
}));

describe('/api/admin/tools/execute', () => {
  it('should reject non-admin users', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        tool: 'modal',
        params: { action: 'list' },
        context: {},
      },
      user: {
        id: 'user123',
        isAdmin: false,
        tags: [],
      },
    });

    await expect(handler(req as any, res as any)).rejects.toThrow('Unauthorized. Admin access required.');
  });

  // No Admin-tag test: the isAdmin flag alone is sufficient for authorization.

  it('should allow admin users', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        tool: 'modal',
        params: { action: 'list' },
        context: {},
      },
      user: {
        id: 'admin123',
        isAdmin: true,
        email: 'admin@test.com',
      },
    });

    await handler(req as any, res as any);

    expect(res._getJSONData()).toEqual({ success: true, data: 'test' });
  });

  it('should not accept user data from client body', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        tool: 'modal',
        params: { action: 'list' },
        context: {},
        // Attempting to pass user from client (should be ignored)
        user: {
          id: 'hacker',
          isAdmin: true,
        },
      },
      user: {
        // Actual authenticated user (not admin)
        id: 'realuser',
        isAdmin: false,
        tags: [],
      },
    });

    // Should reject based on server-authenticated user, not client-provided user
    await expect(handler(req as any, res as any)).rejects.toThrow('Unauthorized. Admin access required.');
  });
});
