// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  middlewares: [] as unknown[],
  rateLimitOptions: null as unknown,
  found: null as null | { id: string; name: string },
  select: vi.fn(),
  findOne: vi.fn(),
  sharesMembership: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: (fn: unknown) => {
      h.middlewares.push(fn);
      return chain;
    },
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      h.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    h.rateLimitOptions = options;
    return 'rate-limit-middleware';
  },
}));
vi.mock('@bike4mind/database', () => ({ User: { findOne: h.findOne } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { sharesMembership: h.sharesMembership } }));

import '../[email]';

async function lookup(email: string) {
  const { req, res } = createMocks({ method: 'GET', query: { email } });
  (req as unknown as { user: unknown }).user = { id: 'caller' };
  await h.getHandler!(req, res);
  return res;
}

describe('GET /api/users/by-email/[email]', () => {
  beforeEach(() => {
    h.found = null;
    h.select.mockReset().mockImplementation(() => Promise.resolve(h.found));
    h.findOne.mockReset().mockReturnValue({ select: h.select });
    h.sharesMembership.mockReset().mockResolvedValue(false);
  });

  it('is rate limited on a stable bucket, not per email', () => {
    expect(h.middlewares).toContain('rate-limit-middleware');
    expect(h.rateLimitOptions).toEqual({ limit: 60, windowMs: 60 * 1000, bucket: 'users-by-email' });
  });

  it('resolves a user who shares an organization with the caller, loading only the name', async () => {
    h.found = { id: 'u1', name: 'Ada' };
    h.sharesMembership.mockResolvedValue(true);
    const res = await lookup('ada@example.com');

    expect(h.findOne).toHaveBeenCalledWith({ email: 'ada@example.com' });
    expect(h.select).toHaveBeenCalledWith('name');
    expect(h.sharesMembership).toHaveBeenCalledWith('caller', 'u1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ id: 'u1', name: 'Ada' });
  });

  it('answers an out-of-scope user exactly as it answers an unknown address', async () => {
    h.found = { id: 'u2', name: 'Grace' };
    h.sharesMembership.mockResolvedValue(false);
    const outOfScope = await lookup('grace@example.com');

    h.found = null;
    const notFound = await lookup('nobody@example.com');

    expect(h.sharesMembership).toHaveBeenNthCalledWith(1, 'caller', 'u2');
    for (const res of [outOfScope, notFound]) {
      expect(res._getStatusCode()).toBe(200);
      expect(res._getData()).toBe('null');
    }
  });

  it('runs the same queries for an unknown address, against an id that matches no one', async () => {
    const res = await lookup('nobody@example.com');

    expect(h.findOne).toHaveBeenCalledTimes(1);
    expect(h.sharesMembership).toHaveBeenCalledTimes(1);
    const [, targetId] = h.sharesMembership.mock.calls[0];
    expect(targetId).toMatch(/^[0-9a-f]{24}$/);
    expect(res._getJSONData()).toBeNull();
  });
});
