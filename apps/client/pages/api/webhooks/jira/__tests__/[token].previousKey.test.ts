// @vitest-environment node
import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

const h = vi.hoisted(() => ({
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findConfig: vi.fn(),
  findSubscriptions: vi.fn(),
  body: '',
}));

vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(
    vi.fn(function () {
      return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    }),
    { error: vi.fn() }
  ),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ success: vi.fn(), failure: vi.fn(), rateLimited: vi.fn() }),
  },
}));
vi.mock('@bike4mind/slack', () => ({
  SlackClient: vi.fn(),
  resolveNotificationDestination: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  jiraWebhookConfigRepository: {
    findByRoutingToken: h.findConfig,
    updateLastDelivery: vi.fn(async () => undefined),
  },
  jiraWebhookSubscriptionRepository: { findActiveByWebhookConfig: h.findSubscriptions },
  jiraWebhookDeliveryRepository: { create: vi.fn() },
}));
vi.mock('@server/integrations/jira/webhookUtils', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/jira/webhookUtils')>()),
  getRawBody: vi.fn(async () => Buffer.from(h.body)),
}));

import handler from '@pages/api/webhooks/jira/[token]';

const routeHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const sign = (secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(h.body).digest('hex')}`;

async function deliver(signature: string) {
  const { req, res } = createMocks({ method: 'POST', query: { token: 'routing-token' } });
  (req as unknown as Record<string, unknown>).headers = { 'x-hub-signature': signature };
  await routeHandler(req, res);
  return res;
}

describe('POST /api/webhooks/jira/[token] with a rotated encryption key', () => {
  let currentKey: string;
  let previousKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    currentKey = generateEncryptionKey();
    previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = currentKey;
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    h.body = JSON.stringify({ webhookEvent: 'jira:issue_updated' });
    h.findSubscriptions.mockResolvedValue([]);
  });

  it('accepts a request signed with a secret stored under the previous key', async () => {
    h.findConfig.mockResolvedValue({
      id: 'cfg-previous-key',
      enabled: true,
      secret: encryptSecret('webhook-secret-fixture', previousKey),
    });

    const res = await deliver(sign('webhook-secret-fixture'));

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, message: 'No active subscriptions' });
  });

  it('accepts a request signed with a rotation-window secret stored under the previous key', async () => {
    h.findConfig.mockResolvedValue({
      id: 'cfg-previous-secret',
      enabled: true,
      secret: encryptSecret('current-secret-fixture', currentKey),
      previousSecret: encryptSecret('retired-secret-fixture', previousKey),
      previousSecretExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await deliver(sign('retired-secret-fixture'));

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, message: 'No active subscriptions' });
  });

  it('rejects a request signed with an unrelated secret', async () => {
    h.findConfig.mockResolvedValue({
      id: 'cfg-unrelated',
      enabled: true,
      secret: encryptSecret('webhook-secret-fixture', previousKey),
    });

    const res = await deliver(sign('unrelated-secret-fixture'));

    expect(res._getStatusCode()).toBe(401);
  });

  it('returns a configuration error when no previous key is configured', async () => {
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = undefined;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    h.findConfig.mockResolvedValue({
      id: 'cfg-no-previous-key',
      enabled: true,
      secret: encryptSecret('webhook-secret-fixture', previousKey),
    });

    const res = await deliver(sign('webhook-secret-fixture'));

    expect(res._getStatusCode()).toBe(500);
  });

  it('returns a configuration error when the secret was stored under neither key', async () => {
    h.findConfig.mockResolvedValue({
      id: 'cfg-unknown-key',
      enabled: true,
      secret: encryptSecret('webhook-secret-fixture', generateEncryptionKey()),
    });

    const res = await deliver(sign('webhook-secret-fixture'));

    expect(res._getStatusCode()).toBe(500);
  });
});
