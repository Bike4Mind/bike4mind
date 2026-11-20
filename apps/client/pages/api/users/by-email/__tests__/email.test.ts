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
  });

  it('is rate limited on a stable bucket, not per email', () => {
    expect(h.middlewares).toContain('rate-limit-middleware');
    expect(h.rateLimitOptions).toEqual({ limit: 60, windowMs: 60 * 1000, bucket: 'users-by-email' });
  });

  it('returns null for an unknown email', async () => {
    const res = await lookup('nobody@example.com');
    expect(res._getJSONData()).toBeNull();
  });

  it('looks up the exact email and loads only the name', async () => {
    h.found = { id: 'u1', name: 'Ada' };
    const res = await lookup('ada@example.com');

    expect(h.findOne).toHaveBeenCalledWith({ email: 'ada@example.com' });
    expect(h.select).toHaveBeenCalledWith('name');
    expect(res._getJSONData()).toEqual({ id: 'u1', name: 'Ada' });
  });
});
