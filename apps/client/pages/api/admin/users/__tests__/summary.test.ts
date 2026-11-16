import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockSummary = vi.fn();
vi.mock('@bike4mind/server-utils/admin/usersList/listAdminUsers', () => ({
  adminUsersSummary: (...args: unknown[]) => mockSummary(...args),
}));

import handler from '../summary';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/users/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSummary.mockResolvedValue({ total: 3 });
  });

  it('requires JWT auth with admin scope and a moderation read permission', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: MODERATION_PAGE_READ },
    });
  });

  it('refuses a delegate without a moderation read permission before reading anything', async () => {
    const delegate = { id: 'd'.repeat(24), isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call(delegate)).rejects.toThrow(missingAdminPermissionMessage(MODERATION_PAGE_READ));
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const res = await call({ id: 'd'.repeat(24), isAdmin: false, adminPermissions: [permission] });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ total: 3 });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
