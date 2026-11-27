// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  update: vi.fn(),
  findByOrganizationId: vi.fn(),
  findOrg: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['get', 'put', 'post', 'delete']) {
      chain[method] = (fn: Handler) => {
        h.handlers[method] = fn;
        return chain;
      };
    }
    return chain;
  },
}));

vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: h.findOrg },
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
  webhookSubscriptionRepository: { findById: h.findById, update: h.update },
}));

await import('../[id]');

const storedSubscription = {
  id: 'sub-1',
  userId: 'user-1',
  organizationId: 'org-1',
  repos: ['acme/app'],
  events: ['push'],
  enabled: true,
  _id: 'mongo-id',
  __v: 3,
  secretNotInSchema: 'hunter2',
  storedOnlyField: 'internal',
};

const undeclaredKeys = ['_id', '__v', 'secretNotInSchema', 'storedOnlyField'];

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

const sentBody = (res: ReturnType<typeof makeRes>) =>
  (res.json.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

const expectStripped = (res: ReturnType<typeof makeRes>) => {
  const body = sentBody(res);
  for (const key of undeclaredKeys) {
    expect(body).not.toHaveProperty(key);
  }
  expect(body).toMatchObject({
    id: 'sub-1',
    userId: 'user-1',
    organizationId: 'org-1',
    repos: ['acme/app'],
    enabled: true,
    organizationName: 'Org',
  });
};

describe('github subscription [id] response key stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ ...storedSubscription });
    h.findByOrganizationId.mockResolvedValue({ repos: [], subscribedEvents: [] });
    h.findOrg.mockResolvedValue({ name: 'Org' });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedSubscription, ...partial }));
  });

  it('GET strips undeclared keys and responds 200', async () => {
    const res = makeRes();
    await h.handlers.get({ user: { id: 'user-1', isAdmin: false }, query: { id: 'sub-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expectStripped(res);
  });

  it('PUT strips undeclared keys and responds 200', async () => {
    const res = makeRes();
    await h.handlers.put(
      { user: { id: 'user-1', isAdmin: false }, query: { id: 'sub-1' }, body: { enabled: true } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expectStripped(res);
  });
});
