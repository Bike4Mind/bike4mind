import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { encryptSecret, generateEncryptionKey } from '@server/security/secretEncryption';

/**
 * Handler-level regression test for the org webhook decrypt path.
 *
 * The inbound org path used to call decryptSecret() directly with only the current
 * SECRET_ENCRYPTION_KEY and no rotation fallback - so once the key was rotated, an org
 * whose secret was still encrypted under the previous key failed every delivery with a
 * 500, triggering a GitHub retry storm. The fix routes decryption through decryptToken(),
 * which tries the current key then SECRET_ENCRYPTION_KEY_PREVIOUS (mirroring the MCP path).
 *
 * secretEncryption + tokenEncryption run for real here so key rotation is genuinely
 * exercised; only the DB / queue / logging boundaries are mocked.
 */

// previousKey = the key the org secret was encrypted under; currentKey = the rotated primary.
const previousKey = generateEncryptionKey();
const currentKey = generateEncryptionKey();
const PLAINTEXT_SECRET = 'org-webhook-signing-secret';
const ROUTING_TOKEN = 'routing-token-abc';

// Secret stored in the DB, encrypted under the now-previous key.
const secretEncryptedWithPreviousKey = encryptSecret(PLAINTEXT_SECRET, previousKey);

const mockConfig: Record<string, string | undefined> = {
  MONGODB_URI: 'mongodb://localhost:27017/%STAGE%',
  STAGE: 'test',
  SECRET_ENCRYPTION_KEY: currentKey,
  SECRET_ENCRYPTION_KEY_PREVIOUS: previousKey,
};
vi.mock('@server/utils/config', () => ({
  Config: new Proxy({}, { get: (_t, key: string) => mockConfig[key] }),
}));

const mockFindByRoutingToken = vi.fn();
const mockUpdateLastDelivery = vi.fn().mockResolvedValue(undefined);
const mockFindByGitHubWebhookToken = vi.fn().mockResolvedValue(null);
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  orgWebhookConfigRepository: {
    findByRoutingToken: (...args: unknown[]) => mockFindByRoutingToken(...args),
    updateLastDelivery: (...args: unknown[]) => mockUpdateLastDelivery(...args),
  },
  mcpServerRepository: {
    findByGitHubWebhookToken: (...args: unknown[]) => mockFindByGitHubWebhookToken(...args),
  },
}));

vi.mock('@bike4mind/observability', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    Logger: vi.fn(function () {
      return logger;
    }),
  };
});

const mockSendToQueue = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/sqs', () => ({
  sendToQueue: (...args: unknown[]) => mockSendToQueue(...args),
}));

vi.mock('@server/utils/dlqRegistry', () => ({
  getSourceQueueUrl: vi.fn(() => 'https://sqs.us-east-2.amazonaws.com/123/githubWebhookQueue'),
}));

const mockTryClaimForProcessing = vi.fn().mockResolvedValue({ claimed: true });
vi.mock('@server/integrations/github/GitHubEvent', () => ({
  GitHubEvent: vi.fn(function () {
    return { tryClaimForProcessing: (...args: unknown[]) => mockTryClaimForProcessing(...args) };
  }),
}));

vi.mock('@server/integrations/github/WebhookAuditLogger', () => ({
  WebhookAuditLogger: {
    create: vi.fn(() => ({ received: vi.fn(), failed: vi.fn(), correlationId: 'corr-1' })),
  },
  extractWebhookMetadata: vi.fn(() => ({})),
}));

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: vi.fn(() => ({ failure: vi.fn(), success: vi.fn(), setUserId: vi.fn() })),
  },
}));

// Import handler after mocks are registered.
const handler = (await import('../../../../pages/api/webhooks/github/[token]')).default;

function signPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function createReqRes(rawBody: string, signature: string) {
  const req = {
    method: 'POST',
    query: { token: ROUTING_TOKEN },
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-123',
      'x-hub-signature-256': signature,
    },
    on: (event: 'data' | 'end' | 'error', cb: (data?: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(rawBody));
      else if (event === 'end') cb();
    },
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;

  return { req, res };
}

describe('GitHub webhook handler — org secret decrypt with key rotation', () => {
  const rawBody = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'org/repo' } });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLastDelivery.mockResolvedValue(undefined);
    mockFindByGitHubWebhookToken.mockResolvedValue(null);
    mockTryClaimForProcessing.mockResolvedValue({ claimed: true });
  });

  it('decrypts an org secret encrypted under the previous key and enqueues the event', async () => {
    mockFindByRoutingToken.mockResolvedValue({
      id: 'cfg-1',
      organizationId: '6985914cd36c7f988bf3a9cd',
      enabled: true,
      secret: secretEncryptedWithPreviousKey,
    });

    // GitHub signs with the plaintext secret; the handler must recover it via the previous key.
    const { req, res } = createReqRes(rawBody, signPayload(rawBody, PLAINTEXT_SECRET));

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSendToQueue).toHaveBeenCalledTimes(1);
    const [, payload] = mockSendToQueue.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.isOrgWebhook).toBe(true);
    expect(payload.orgId).toBe('6985914cd36c7f988bf3a9cd');
  });

  it('returns 500 without enqueuing when the secret cannot be decrypted under either key', async () => {
    const unknownKey = generateEncryptionKey();
    mockFindByRoutingToken.mockResolvedValue({
      id: 'cfg-1',
      organizationId: '6985914cd36c7f988bf3a9cd',
      enabled: true,
      secret: encryptSecret(PLAINTEXT_SECRET, unknownKey),
    });

    const { req, res } = createReqRes(rawBody, signPayload(rawBody, PLAINTEXT_SECRET));

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockSendToQueue).not.toHaveBeenCalled();
  });
});
