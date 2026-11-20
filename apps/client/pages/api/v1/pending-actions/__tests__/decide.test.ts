import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { contracts, decidePendingAction } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  decidePendingAction: vi.fn(),
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      { post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/mcp/decidePendingAction', () => ({ decidePendingAction }));

import approve from '../[questId]/approve';
import deny from '../[questId]/deny';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (handler: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, {
    user: { id: 'user-1' },
    validatedParams: { questId: 'quest-1' },
    validated: { pendingActionTs: 123 },
    logger: {},
  });
  await (handler as Handler)(req, res);
  return res;
};

describe('/api/v1/pending-actions/[questId]/{approve,deny}', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decidePendingAction.mockResolvedValue({ status: 200, body: { success: true, message: 'ok' } });
  });

  it('are JWT-only with no scopes (an API key is refused before it is validated)', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['approvePendingAction', 'jwtOnly', undefined],
      ['denyPendingAction', 'jwtOnly', undefined],
    ]);
  });

  it('approve runs the decision with confirmed=true for the JWT user and the path quest', async () => {
    const res = await call(approve);

    expect(decidePendingAction).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'user-1' }, questId: 'quest-1', pendingActionTs: 123, confirmed: true })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true, message: 'ok' });
  });

  it('deny runs the decision with confirmed=false', async () => {
    await call(deny);

    expect(decidePendingAction).toHaveBeenCalledWith(expect.objectContaining({ questId: 'quest-1', confirmed: false }));
  });

  it('relays the status and body of a lifecycle refusal', async () => {
    decidePendingAction.mockResolvedValue({ status: 409, body: { error: 'x', errorCode: 'action_replaced' } });

    const res = await call(approve);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'action_replaced' });
  });
});
