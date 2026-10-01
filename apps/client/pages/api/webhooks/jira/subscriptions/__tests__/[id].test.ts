// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  update: vi.fn(),
  findConfigById: vi.fn(),
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

vi.mock('@bike4mind/database', () => ({
  jiraWebhookConfigRepository: { findById: h.findConfigById },
  jiraWebhookSubscriptionRepository: { findById: h.findById, update: h.update },
}));

await import('../[id]');

const healthy = { id: 'jsub-1', userId: 'user-1', webhookConfigId: 'jcfg-1', enabled: false, consecutiveFailures: 0 };
const tripped = {
  ...healthy,
  consecutiveFailures: 5,
  autoDisabledAt: new Date('2026-01-01T00:00:00.000Z'),
  autoDisabledReason: 'too many failures',
  circuitBreakerOpenedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

const put = (body: Record<string, unknown>) =>
  h.handlers.put({ user: { id: 'user-1', isAdmin: false }, query: { id: 'jsub-1' }, body }, makeRes());

describe('PUT /api/webhooks/jira/subscriptions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ ...healthy });
    h.findConfigById.mockResolvedValue({ atlassianSiteUrl: 'https://site.example.net' });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...healthy, ...partial }));
  });

  it('writes only name when only name is sent', async () => {
    await put({ name: 'renamed' });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jsub-1', name: 'renamed' });
  });

  it('resets every circuit-breaker field when re-enabling an auto-disabled subscription', async () => {
    h.findById.mockResolvedValue({ ...tripped });

    await put({ enabled: true });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({
      id: 'jsub-1',
      enabled: true,
      consecutiveFailures: 0,
      autoDisabledAt: null,
      autoDisabledReason: null,
      circuitBreakerOpenedAt: null,
    });
  });

  it('writes only enabled when re-enabling a subscription that was not auto-disabled', async () => {
    await put({ enabled: true });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jsub-1', enabled: true });
  });
});
