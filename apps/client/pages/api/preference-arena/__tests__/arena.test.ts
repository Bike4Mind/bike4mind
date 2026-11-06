import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const { mockServe, mockSubmit } = vi.hoisted(() => ({ mockServe: vi.fn(), mockSubmit: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, Handler> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => handlers[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: Handler) => ((handlers.GET = fn), chain),
        post: (fn: Handler) => ((handlers.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@server/preferenceArena', () => ({
  getArenaService: () => ({ serveNextPair: mockServe, submitVote: mockSubmit }),
}));

import nextHandler from '../next';
import voteHandler from '../vote';

const call = async (handler: unknown, method: 'GET' | 'POST', user?: { id: string }, body?: unknown) => {
  const { req, res } = createMocks({ method, body: body as never });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as Handler)(req, res);
  return res;
};

describe('arena user routes', () => {
  beforeEach(() => {
    mockServe.mockReset();
    mockSubmit.mockReset();
  });

  it('GET next answers 401 without a user', async () => {
    const res = await call(nextHandler, 'GET');
    expect(res._getStatusCode()).toBe(401);
    expect(mockServe).not.toHaveBeenCalled();
  });

  it('GET next returns the served pair for the session user', async () => {
    mockServe.mockResolvedValue({ status: 'empty' });
    const res = await call(nextHandler, 'GET', { id: 'u1' });
    expect(mockServe).toHaveBeenCalledWith('u1');
    expect(res._getJSONData()).toEqual({ status: 'empty' });
  });

  it('POST vote answers 401 without a user', async () => {
    const res = await call(voteHandler, 'POST', undefined, { pairId: 'a'.repeat(24), choice: 'a' });
    expect(res._getStatusCode()).toBe(401);
  });

  it('POST vote rejects a malformed body with 400', async () => {
    await expect(call(voteHandler, 'POST', { id: 'u1' }, { pairId: 'nope', choice: 'a' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      call(voteHandler, 'POST', { id: 'u1' }, { pairId: 'a'.repeat(24), choice: 'x' })
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('POST vote submits a valid vote', async () => {
    mockSubmit.mockResolvedValue({ creditsAwarded: 2 });
    const body = { pairId: 'a'.repeat(24), choice: 'tie' };
    const res = await call(voteHandler, 'POST', { id: 'u1' }, body);
    expect(mockSubmit).toHaveBeenCalledWith('u1', body);
    expect(res._getJSONData()).toEqual({ creditsAwarded: 2 });
  });
});
