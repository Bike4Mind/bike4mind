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

const storedSubscription = { id: 'sub-1', userId: 'user-1', organizationId: 'org-1', enabled: true };

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

const put = (body: Record<string, unknown>) =>
  h.handlers.put({ user: { id: 'user-1', isAdmin: false }, query: { id: 'sub-1' }, body }, makeRes());

describe('PUT /api/webhooks/github/subscriptions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ ...storedSubscription });
    h.findByOrganizationId.mockResolvedValue({ repos: [], subscribedEvents: [] });
    h.findOrg.mockResolvedValue({ name: 'Org' });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedSubscription, ...partial }));
  });

  it('writes only enabled when only enabled is sent', async () => {
    await put({ enabled: false });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'sub-1', enabled: false });
  });

  it('writes only mcpServerId when only mcpServerId is sent', async () => {
    await put({ mcpServerId: 'mcp-1' });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'sub-1', mcpServerId: 'mcp-1' });
  });
});
