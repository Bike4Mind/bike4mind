import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockExport = vi.fn();
vi.mock('@server/admin/usersList/listAdminUsers', () => ({
  exportAdminUsers: (...args: unknown[]) => mockExport(...args),
}));

import handler from '../export';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/users/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExport.mockResolvedValue({ users: [], truncated: false });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: MODERATION_PAGE_READ },
    });
  });

  it('refuses a delegate without a moderation read permission before reading anything', async () => {
    const delegate = { id: 'd'.repeat(24), isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call({}, delegate)).rejects.toThrow(missingAdminPermissionMessage(MODERATION_PAGE_READ));
    expect(mockExport).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const res = await call({}, { id: 'd'.repeat(24), isAdmin: false, adminPermissions: [permission] });
    expect(res._getStatusCode()).toBe(200);
    expect(mockExport).toHaveBeenCalledTimes(1);
  });

  it('exports with the parsed filter and no-store caching', async () => {
    mockExport.mockResolvedValue({ users: [{ username: 'u' }], truncated: true });
    const res = await call({ status: 'suspended', emailDomain: 'Example.com' });
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({ users: [{ username: 'u' }], truncated: true });
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'suspended', emailDomain: 'example.com' })
    );
  });

  it("accepts up to 50 tags, past qs's default array limit of 20", async () => {
    const tags = Array.from({ length: 50 }, (_, index) => `tag${index}`);
    const query = Object.fromEntries(tags.map((tag, index) => [`tags[${index}]`, tag]));
    expect((await call(query))._getStatusCode()).toBe(200);
    expect(mockExport.mock.calls[0][0]).toMatchObject({ tags });
  });

  it('rejects an invalid filter with 400', async () => {
    const res = await call({ status: 'bogus' });
    expect(res._getStatusCode()).toBe(400);
    const { error, issues } = res._getJSONData() as { error: string; issues: unknown[] };
    expect(typeof error).toBe('string');
    expect(error.length).toBeGreaterThan(0);
    expect(Array.isArray(issues)).toBe(true);
    expect(mockExport).not.toHaveBeenCalled();
  });
});
