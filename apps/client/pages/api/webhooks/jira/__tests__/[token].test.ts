// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'key' } }));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ decryptSecret: vi.fn(() => 'secret') }));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ success: vi.fn(), failure: vi.fn(), rateLimited: vi.fn() }),
  },
}));

const { mockSendMessage, mockResolveDestination, mockRecordDelivery } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockResolveDestination: vi.fn(),
  mockRecordDelivery: vi.fn(),
}));

vi.mock('@bike4mind/slack', () => ({
  SlackClient: vi.fn(function () {
    return { sendMessage: mockSendMessage };
  }),
  resolveNotificationDestination: mockResolveDestination,
}));

const { mockFindConfig, mockFindSubscriptions, mockResetFailures, mockIncrementFailures } = vi.hoisted(() => ({
  mockFindConfig: vi.fn(),
  mockFindSubscriptions: vi.fn(),
  mockResetFailures: vi.fn(),
  mockIncrementFailures: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  jiraWebhookConfigRepository: {
    findByRoutingToken: mockFindConfig,
    updateLastDelivery: vi.fn(async () => undefined),
  },
  jiraWebhookSubscriptionRepository: {
    findActiveByWebhookConfig: mockFindSubscriptions,
    resetConsecutiveFailures: mockResetFailures,
    incrementConsecutiveFailuresAtomic: mockIncrementFailures,
  },
  jiraWebhookDeliveryRepository: { create: mockRecordDelivery },
}));

vi.mock('@server/integrations/jira/webhookUtils', () => ({
  getRawBody: vi.fn(async () => Buffer.from(JSON.stringify(webhookPayload))),
  verifyJiraSignature: vi.fn(() => ({ valid: true })),
  validateJiraPayloadTimestamp: vi.fn(() => ({ valid: true })),
  PayloadTooLargeError: class PayloadTooLargeError extends Error {},
}));
vi.mock('@server/integrations/jira/types', () => ({
  extractIssueInfo: vi.fn(() => ({ projectKey: 'P', issueKey: 'P-1', summary: 'Summary' })),
  matchesFilters: vi.fn(() => true),
}));

import { JiraWebhookDeliveryStatus } from '@bike4mind/common';
import handler from '@pages/api/webhooks/jira/[token]';

const routeHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const subscription = {
  id: 'sub-1',
  userId: 'user-1',
  slackTarget: { type: 'channel', channelId: 'C123' },
  projectFilter: [],
  priorityFilter: [],
  issueTypeFilter: [],
};

const webhookPayload = {
  webhookEvent: 'jira:issue_updated',
  timestamp: 1_760_000_000_000,
  issue: {
    id: '10001',
    key: 'P-1',
    fields: {
      summary: 'A summary',
      project: { key: 'P', name: 'Project' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      status: { name: 'Open' },
    },
  },
};

async function deliver() {
  const { req, res } = createMocks({ method: 'POST', query: { token: 'routing-token' } });
  (req as Record<string, unknown>).headers = { 'x-hub-signature': 'sig' };
  await routeHandler(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindConfig.mockResolvedValue({ id: 'cfg-1', enabled: true, secret: 'enc', atlassianSiteUrl: 'https://x.test' });
  mockFindSubscriptions.mockResolvedValue([subscription]);
  mockResetFailures.mockResolvedValue(undefined);
  mockIncrementFailures.mockResolvedValue({ wasAutoDisabled: false });
  mockRecordDelivery.mockResolvedValue(undefined);
  mockSendMessage.mockResolvedValue('ts-1');
  mockResolveDestination.mockResolvedValue({ botToken: 'xoxb-test', channel: 'C123', slackTeamId: 'T1' });
});

describe('POST /api/webhooks/jira/[token] delivery', () => {
  it('posts to the channel the verified destination resolved', async () => {
    const res = await deliver();

    expect(res._getStatusCode()).toBe(200);
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled());
    expect(mockResolveDestination).toHaveBeenCalledWith('user-1', 'C123');
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }));
    await vi.waitFor(() =>
      expect(mockRecordDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ status: JiraWebhookDeliveryStatus.Success })
      )
    );
    expect(mockIncrementFailures).not.toHaveBeenCalled();
  });

  it('sends nothing and records a failure without counting it when the destination check refuses', async () => {
    mockResolveDestination.mockRejectedValue(new Error('Connect with Slack to verify your identity first'));

    const res = await deliver();

    expect(res._getStatusCode()).toBe(200);
    await vi.waitFor(() => expect(mockRecordDelivery).toHaveBeenCalled());
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockIncrementFailures).not.toHaveBeenCalled();
    expect(mockRecordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        status: JiraWebhookDeliveryStatus.Failed,
        errorMessage: 'Connect with Slack to verify your identity first',
      })
    );
  });

  it('does not count a delivered message as failed when bookkeeping after the send throws', async () => {
    mockResetFailures.mockRejectedValue(new Error('db write failed'));

    await deliver();

    await vi.waitFor(() => expect(mockResetFailures).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockSendMessage).toHaveBeenCalled();
    expect(mockIncrementFailures).not.toHaveBeenCalled();
    expect(mockRecordDelivery).not.toHaveBeenCalled();
  });
});
