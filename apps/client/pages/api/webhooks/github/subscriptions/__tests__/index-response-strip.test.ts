// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  create: vi.fn(),
  findByUserId: vi.fn(),
  countByOrganization: vi.fn(),
  findByUserAndOrg: vi.fn(),
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
  webhookSubscriptionRepository: {
    create: h.create,
    findByUserId: h.findByUserId,
    countByOrganization: h.countByOrganization,
    findByUserAndOrg: h.findByUserAndOrg,
  },
}));

await import('../index');

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

const sentBody = (res: ReturnType<typeof makeRes>) => (res.json.mock.calls[0] as unknown[])[0];

const expectStripped = (item: Record<string, unknown>) => {
  for (const key of undeclaredKeys) {
    expect(item).not.toHaveProperty(key);
  }
  expect(item).toMatchObject({
    id: 'sub-1',
    userId: 'user-1',
    organizationId: 'org-1',
    repos: ['acme/app'],
    enabled: true,
    organizationName: 'Org',
  });
};

describe('github subscriptions index response key stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findOrg.mockResolvedValue({ name: 'Org', userId: 'user-1', users: [] });
    h.findByOrganizationId.mockResolvedValue({ enabled: true, repos: [], subscribedEvents: [] });
    h.countByOrganization.mockResolvedValue(0);
    h.findByUserAndOrg.mockResolvedValue(null);
    h.create.mockResolvedValue({ ...storedSubscription });
    h.findByUserId.mockResolvedValue([{ ...storedSubscription }, { ...storedSubscription, id: 'sub-2' }]);
  });

  it('POST strips undeclared keys and responds 201', async () => {
    const res = makeRes();
    await h.handlers.post(
      {
        user: { id: 'user-1', isAdmin: false },
        body: { organizationId: 'org-1', repos: ['acme/app'], events: ['push'] },
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expectStripped(sentBody(res) as Record<string, unknown>);
  });

  it('GET list strips undeclared keys from every item and responds 200', async () => {
    const res = makeRes();
    await h.handlers.get({ user: { id: 'user-1', isAdmin: false } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const items = sentBody(res) as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      for (const key of undeclaredKeys) {
        expect(item).not.toHaveProperty(key);
      }
      expect(item).toMatchObject({ userId: 'user-1', enabled: true, organizationName: 'Org' });
    }
  });
});
