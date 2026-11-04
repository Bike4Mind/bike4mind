import { beforeEach, describe, expect, it, vi } from 'vitest';

const complete = vi.hoisted(() => vi.fn());

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (...fns: Array<(req: unknown, res: unknown) => unknown>) => fns[fns.length - 1],
  }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@server/mcpConnections/customMcpAccess', () => ({
  assertCustomMcpEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock('@server/mcpConnections/oauth/completeOAuth', () => ({ completeUserConnectionOAuth: complete }));

import handler from '../callback';

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
