import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contracts, pushTokenRepository } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  pushTokenRepository: { upsert: vi.fn(), removeByToken: vi.fn() },
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      {
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
// The real dispatcher pulls in baseApi (and with it the whole auth/db graph); its 405 behavior is
// its own concern.
vi.mock('@server/middlewares/dispatchByMethod', () => ({
  dispatchByMethod:
    (routes: Record<string, (req: unknown, res: { status: (code: number) => { end: () => void } }) => unknown>) =>
    (req: { method: string }, res: { status: (code: number) => { end: () => void } }) =>
      routes[req.method] ? routes[req.method](req, res) : res.status(405).end(),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({ pushTokenRepository }));

import handler from '../push-tokens';

const call = async (method: 'POST' | 'DELETE', user: Record<string, unknown>, validated: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user, validated });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const registration = { token: 'tok', kind: 'device', platform: 'ios', environment: 'sandbox' };

describe('/api/v1/push-tokens', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is JWT-only with no scopes on both verbs (an API key is refused before it is validated)', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['registerPushToken', 'jwtOnly', undefined],
      ['unregisterPushToken', 'jwtOnly', undefined],
    ]);
  });

  it('registers the token under the session id from the JWT, never the body', async () => {
    const res = await call('POST', { id: 'user-1', sid: 'sid-from-jwt' }, { ...registration, sid: 'sid-from-body' });
    expect(res._getStatusCode()).toBe(204);
    expect(pushTokenRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ...registration, userId: 'user-1', sid: 'sid-from-jwt' })
    );
  });

  it('refuses a token that carries no session, since logout could never prune it', async () => {
    await expect(call('POST', { id: 'user-1' }, registration)).rejects.toThrow(/no session/);
    expect(pushTokenRepository.upsert).not.toHaveBeenCalled();
  });

  it('unregister is scoped to the caller and succeeds for an unknown token', async () => {
    pushTokenRepository.removeByToken.mockResolvedValue(false);
    const res = await call('DELETE', { id: 'user-1', sid: 's' }, { token: 'ghost' });
    expect(res._getStatusCode()).toBe(204);
    expect(pushTokenRepository.removeByToken).toHaveBeenCalledWith('ghost', { userId: 'user-1' });
  });

  it('405s a verb the path does not serve', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await (handler as unknown as (req: unknown, res: unknown) => unknown)(req, res);
    expect(res._getStatusCode()).toBe(405);
  });
});
