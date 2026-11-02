// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const route =
      (method: string) =>
      (...fns: ((req: unknown, res: unknown) => unknown)[]) => {
        handlers[method] = fns[fns.length - 1];
        return chain;
      };
    const chain = Object.assign(
      (req: unknown, res: unknown) => handlers[(req as { method?: string }).method ?? 'GET']?.(req, res),
      { use: () => chain, post: route('POST'), get: route('GET') }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => async (req: unknown, res: unknown) => {
    const { default: errorHandler } = await import('@server/middlewares/errorHandler');
    try {
      await fn(req, res);
    } catch (error) {
      errorHandler(error as never, req as never, res as never);
    }
  },
}));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => {
  const MockLogger = vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });
  MockLogger.info = vi.fn();
  MockLogger.warn = vi.fn();
  MockLogger.error = vi.fn();
  return { Logger: MockLogger };
});

const { mockResolveDestination, mockFindById, mockFindByUserAndConfig, mockCreate, mockGetValidTokens } = vi.hoisted(
  () => ({
    mockResolveDestination: vi.fn(),
    mockFindById: vi.fn(),
    mockFindByUserAndConfig: vi.fn(),
    mockCreate: vi.fn(),
    mockGetValidTokens: vi.fn(),
  })
);

vi.mock('@bike4mind/slack', () => ({ resolveNotificationDestination: mockResolveDestination }));
vi.mock('@bike4mind/database', () => ({
  jiraWebhookConfigRepository: { findById: mockFindById },
  jiraWebhookSubscriptionRepository: {
    findByUserAndConfig: mockFindByUserAndConfig,
    create: mockCreate,
    findByUserId: vi.fn(async () => []),
  },
}));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: mockGetValidTokens },
}));
vi.mock('@server/integrations/jira/types', () => ({ validateFilters: vi.fn(() => undefined) }));

import handler from '@pages/api/webhooks/jira/subscriptions/index';

const routeHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const body = {
  webhookConfigId: 'cfg-1',
  slackTarget: { type: 'channel', channelId: 'C123' },
};

const createdSubscription = {
  id: 'sub-1',
  userId: 'user-1',
  webhookConfigId: 'cfg-1',
  atlassianCloudId: 'cloud-1',
  slackTarget: body.slackTarget,
  projectFilter: [],
  priorityFilter: [],
  issueTypeFilter: [],
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
  mockResolveDestination.mockResolvedValue({ botToken: 'xoxb-test', channel: 'C123', slackTeamId: 'T1' });
  mockFindById.mockResolvedValue({ id: 'cfg-1', atlassianCloudId: 'cloud-1', atlassianSiteUrl: 'https://x.test' });
  mockFindByUserAndConfig.mockResolvedValue(null);
  mockCreate.mockResolvedValue(createdSubscription);
});

async function create() {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as Record<string, unknown>).user = { id: 'user-1' };
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  await routeHandler(req, res);
  return res;
}

describe('POST /api/webhooks/jira/subscriptions', () => {
  it('saves a channel the linked member belongs to', async () => {
    const res = await create();

    expect(res._getStatusCode()).toBe(201);
    expect(mockResolveDestination).toHaveBeenCalledWith('user-1', 'C123');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('rejects a channel the caller does not belong to and creates nothing', async () => {
    mockResolveDestination.mockRejectedValue(new Error('You must be a member of the notification channel'));

    const res = await create();

    expect(res._getStatusCode()).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
