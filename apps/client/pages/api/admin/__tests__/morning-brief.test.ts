import { describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
const h = vi.hoisted(() => ({ latest: vi.fn(), options: [] as unknown[] }));
vi.mock('@bike4mind/database', () => ({ adminMorningBriefRepository: { findLatest: h.latest } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'dev' } }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.options.push(options);
    return { get: (handler: unknown) => handler };
  },
}));
import handler from '../morning-brief';
const call = async (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user });
  await handler(req as never, res as never);
  return res;
};
describe('latest morning brief route', () => {
  it('requires a JWT and full admin before querying cross-queue facts', async () => {
    expect(h.options[0]).toMatchObject({ auth: 'jwtOnly' });
    await expect(call({ id: 'delegate', adminPermissions: ['support:read'] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.latest).not.toHaveBeenCalled();
  });
  it('returns only the current environment and no cacheable response', async () => {
    h.latest.mockResolvedValue(null);
    const res = await call({ id: 'admin', isAdmin: true });
    expect(h.latest).toHaveBeenCalledWith('dev');
    expect(res._getJSONData()).toEqual({ brief: null });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
