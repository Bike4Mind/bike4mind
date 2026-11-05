import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import { STEP_UP_REQUIRED_CODE } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  config: undefined as unknown,
  findBySid: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
  findById: vi.fn(),
  owned: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', async () => {
  const nc = (await import('next-connect')).default;
  return {
    baseApi: (options: unknown) => {
      h.config = options;
      return nc({
        onError: (err: { statusCode?: number; message: string; additionalInfo?: object }, _req, res: any) =>
          res.status(err.statusCode ?? 500).json({ error: err.message, ...err.additionalInfo }),
      });
    },
  };
});
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: h.findBySid },
  passkeyCredentialRepository: {},
  userRepository: { findById: h.findById },
}));
vi.mock('@bike4mind/services', () => ({ mfaService: {} }));
vi.mock('@server/users/accountDeletion', () => ({
  requestAccountDeletion: h.request,
  cancelAccountDeletion: h.cancel,
  findOwnedOrganizations: h.owned,
}));

import handler from '../deletion';

const liveSession = (over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

async function call(method: RequestMethod, user: Record<string, unknown> = { id: 'u1', sid: 's1' }) {
  const { req, res } = createMocks({ method, url: '/api/account/deletion' }, { eventEmitter: EventEmitter });
  Object.assign(req as any, { user });
  await (handler as any)(req, res);
  return { status: res._getStatusCode(), body: res._isJSON() ? res._getJSONData() : undefined };
}

describe('/api/account/deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.request.mockResolvedValue({
      deletion: { scheduledFor: new Date('2026-11-17T00:00:00.000Z') },
      subscriptions: { canceled: ['sub_1'], failed: [] },
    });
  });

  it('accepts a JWT session only, so an API key is never a credential here', () => {
    expect(h.config).toMatchObject({ auth: 'jwtOnly' });
  });

  it('requires a recent step-up before scheduling the deletion', async () => {
    h.findBySid.mockResolvedValue(liveSession());
    const { status, body } = await call('POST');
    expect(status).toBe(403);
    expect(body.code).toBe(STEP_UP_REQUIRED_CODE);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('refuses a request with no session to step up (API key, legacy token)', async () => {
    const { status } = await call('POST', { id: 'u1' });
    expect(status).toBe(403);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('schedules the deletion once the session has stepped up', async () => {
    h.findBySid.mockResolvedValue(liveSession({ stepUpAt: new Date() }));
    const { status, body } = await call('POST');
    expect(status).toBe(202);
    expect(body.canceledSubscriptions).toBe(1);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('cancels without a step-up, since a frozen session has just signed in', async () => {
    const { status } = await call('DELETE');
    expect(status).toBe(204);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.findBySid).not.toHaveBeenCalled();
  });

  it('reports the pending deletion and the organizations blocking a request', async () => {
    h.findById.mockResolvedValue({ deletion: null });
    h.owned.mockResolvedValue([{ id: 'o1', name: 'Acme' }]);
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(body).toEqual({ deletion: null, ownedOrganizations: [{ id: 'o1', name: 'Acme' }] });
  });
});
