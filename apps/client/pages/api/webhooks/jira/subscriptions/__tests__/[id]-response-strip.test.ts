// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  update: vi.fn(),
  findConfigById: vi.fn(),
  destination: vi.fn(),
}));

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ resolveNotificationDestination: h.destination }));

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

const storedSubscription = {
  id: 'jsub-1',
  userId: 'user-1',
  webhookConfigId: 'jcfg-1',
  atlassianCloudId: 'cloud-1',
  slackTarget: { type: 'channel', channelId: 'C123' },
  projectFilter: ['PROJ'],
  priorityFilter: [],
  issueTypeFilter: [],
  enabled: true,
  consecutiveFailures: 0,
  _id: 'mongo-id',
  __v: 2,
  secretNotInSchema: 'hunter2',
};

const undeclaredKeys = ['_id', '__v', 'secretNotInSchema'];

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

const expectStripped = (res: ReturnType<typeof makeRes>) => {
  const body = (res.json.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  for (const key of undeclaredKeys) {
    expect(body).not.toHaveProperty(key);
  }
  expect(body).toMatchObject({
    id: 'jsub-1',
    userId: 'user-1',
    webhookConfigId: 'jcfg-1',
    slackTarget: { type: 'channel', channelId: 'C123' },
    enabled: true,
    atlassianSiteName: 'https://site.example.net',
  });
};

describe('jira subscription [id] response key stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ ...storedSubscription });
    h.findConfigById.mockResolvedValue({ atlassianSiteUrl: 'https://site.example.net' });
    h.destination.mockResolvedValue({});
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedSubscription, ...partial }));
  });

  it('GET strips undeclared keys and responds 200', async () => {
    const res = makeRes();
    await h.handlers.get({ user: { id: 'user-1', isAdmin: false }, query: { id: 'jsub-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expectStripped(res);
  });

  it('PUT strips undeclared keys and responds 200', async () => {
    const res = makeRes();
    await h.handlers.put(
      { user: { id: 'user-1', isAdmin: false }, query: { id: 'jsub-1' }, body: { name: 'renamed' } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expectStripped(res);
  });
});
