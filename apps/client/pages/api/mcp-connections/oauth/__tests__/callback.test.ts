import { beforeEach, describe, expect, it, vi } from 'vitest';

const refs = vi.hoisted(() => ({
  complete: vi.fn(),
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
}));

// `auth: 'jwtOnly'` is what binds the single-use state to the session, so the options are captured, not dropped.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    refs.baseApiOptions = options;
    return { post: (...fns: Array<(req: unknown, res: unknown) => unknown>) => fns[fns.length - 1] };
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    refs.rateLimitOptions = options;
    return undefined;
  },
}));
vi.mock('@server/mcpConnections/customMcpAccess', () => ({
  assertCustomMcpEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock('@server/mcpConnections/oauth/completeOAuth', () => ({ completeUserConnectionOAuth: refs.complete }));

import handler from '../callback';

const complete = refs.complete;

const call = async (body: unknown) => {
  const res = { json: vi.fn() };
  const outcome = await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(
    { user: { id: 'u1' }, body },
    res
  ).then(
    () => 'ok',
    (error: { additionalInfo?: { code?: string } }) => error
  );
  return { res, outcome };
};

describe('POST /api/mcp-connections/oauth/callback', () => {
  beforeEach(() => complete.mockReset());

  it('accepts only a session JWT, and is rate limited in its own bucket', () => {
    expect(refs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    expect(refs.rateLimitOptions).toMatchObject({ bucket: 'POST /api/mcp-connections/oauth/callback', limit: 20 });
  });

  it('hands the code, state and iss to the service and returns its view', async () => {
    complete.mockResolvedValue({ id: 'c1' });
    const { res } = await call({ code: 'abc', state: 'st', iss: 'https://as.example' });
    expect(complete).toHaveBeenCalledWith(
      { id: 'u1' },
      { enabled: true },
      { code: 'abc', state: 'st', iss: 'https://as.example' }
    );
    expect(res.json).toHaveBeenCalledWith({ id: 'c1' });
  });

  it.each([{}, { code: 'abc' }, { state: 'st' }, { code: 'abc', state: 'st', extra: 1 }])(
    'refuses the body %j before reaching the service',
    async body => {
      const { outcome } = await call(body);
      expect(outcome).toMatchObject({ additionalInfo: { code: 'invalid_body' } });
      expect(complete).not.toHaveBeenCalled();
    }
  );
});
