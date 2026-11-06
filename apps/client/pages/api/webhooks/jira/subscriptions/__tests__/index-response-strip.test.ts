// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  destination: vi.fn(),
  findConfigById: vi.fn(),
  findByUserAndConfig: vi.fn(),
  create: vi.fn(),
  findByUserId: vi.fn(),
  getValidTokens: vi.fn(),
}));

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/slack', () => ({ resolveNotificationDestination: h.destination }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: h.getValidTokens },
}));
vi.mock('@server/integrations/jira/types', () => ({ validateFilters: vi.fn(() => undefined) }));

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
  jiraWebhookSubscriptionRepository: {
    findByUserAndConfig: h.findByUserAndConfig,
    create: h.create,
    findByUserId: h.findByUserId,
  },
}));

await import('../index');

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

const sentBody = (res: ReturnType<typeof makeRes>) => (res.json.mock.calls[0] as unknown[])[0];

const expectStripped = (item: Record<string, unknown>, id = 'jsub-1') => {
  for (const key of undeclaredKeys) {
    expect(item).not.toHaveProperty(key);
  }
  expect(item).toMatchObject({
    id,
    userId: 'user-1',
    webhookConfigId: 'jcfg-1',
    slackTarget: { type: 'channel', channelId: 'C123' },
    enabled: true,
    atlassianSiteName: 'https://site.example.net',
  });
};

describe('jira subscriptions index response key stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.destination.mockResolvedValue({});
    h.findConfigById.mockResolvedValue({
      id: 'jcfg-1',
      atlassianCloudId: 'cloud-1',
      atlassianSiteUrl: 'https://site.example.net',
    });
    h.findByUserAndConfig.mockResolvedValue(null);
    h.create.mockResolvedValue({ ...storedSubscription });
    h.findByUserId.mockResolvedValue([{ ...storedSubscription }, { ...storedSubscription, id: 'jsub-2' }]);
  });

  it('POST strips undeclared keys and responds 201', async () => {
    const res = makeRes();
    await h.handlers.post(
      {
        user: { id: 'user-1' },
        body: { webhookConfigId: 'jcfg-1', slackTarget: { type: 'channel', channelId: 'C123' } },
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expectStripped(sentBody(res) as Record<string, unknown>);
  });

  it('GET list strips undeclared keys from every item and responds 200', async () => {
    const res = makeRes();
    await h.handlers.get({ user: { id: 'user-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const items = sentBody(res) as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expectStripped(items[0]);
    expectStripped(items[1], 'jsub-2');
  });
});
