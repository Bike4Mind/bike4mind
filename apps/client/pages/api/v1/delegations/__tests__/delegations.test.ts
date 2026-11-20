import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contracts, mocks } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  mocks: { createDelegation: vi.fn(), findByIdForUser: vi.fn() },
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      {
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/delegations/createDelegation', () => ({ createDelegation: mocks.createDelegation }));
vi.mock('@bike4mind/database', () => ({ delegatedItemRepository: { findByIdForUser: mocks.findByIdForUser } }));

import createHandler from '../index';
import getHandler from '../[id]';

const stored = {
  _id: { toString: () => 'g1' },
  intent: 'Summarize',
  url: null,
  text: 'notes',
  fileIds: [],
  status: 'pending',
  result: null,
  createdAt: new Date('2026-11-19T00:00:00Z'),
  settledAt: null,
};

type Handler = (req: unknown, res: unknown) => Promise<void>;
const call = async (handler: unknown, method: 'GET' | 'POST', extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: 'u1' }, ...extra });
  await (handler as Handler)(req, res);
  return res;
};

describe('/api/v1/delegations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts an API key or a JWT, gated on the AI scopes', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['createDelegation', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
      ['getDelegation', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
    ]);
  });

  it('creates the delegation for the caller and answers 202 with it pending', async () => {
    mocks.createDelegation.mockResolvedValue(stored);
    const body = { intent: 'Summarize', text: 'notes' };
    const res = await call(createHandler, 'POST', { validated: body });

    expect(mocks.createDelegation).toHaveBeenCalledWith('u1', body);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ id: 'g1', status: 'pending', text: 'notes' });
  });

  it('reads the caller own delegation', async () => {
    mocks.findByIdForUser.mockResolvedValue(stored);
    const res = await call(getHandler, 'GET', { validatedParams: { id: 'g1' } });
    expect(mocks.findByIdForUser).toHaveBeenCalledWith('g1', 'u1');
    expect(res._getJSONData()).toMatchObject({ id: 'g1', intent: 'Summarize' });
  });

  it('404s a delegation that is missing or someone else', async () => {
    mocks.findByIdForUser.mockResolvedValue(null);
    await expect(call(getHandler, 'GET', { validatedParams: { id: 'g2' } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses a key minted for a connected app on both routes', async () => {
    const exchangeKey = { apiKeyInfo: { oauthExchangeClientId: 'client-1' } };
    await expect(
      call(createHandler, 'POST', { ...exchangeKey, validated: { intent: 'Summarize', text: 'notes' } })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(call(getHandler, 'GET', { ...exchangeKey, validatedParams: { id: 'g1' } })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.createDelegation).not.toHaveBeenCalled();
    expect(mocks.findByIdForUser).not.toHaveBeenCalled();
  });
});
