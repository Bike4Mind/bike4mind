import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { encryptSecret, generateEncryptionKey } from '@server/security/secretEncryption';

/**
 * Handler-level regression test for the SRE webhook decrypt path.
 *
 * The SRE endpoint used to call decryptSecret() directly with only the current
 * SECRET_ENCRYPTION_KEY and no rotation fallback - so once the key was rotated, an SRE
 * secret still encrypted under the previous key failed every delivery with a 500,
 * triggering a GitHub retry storm. The fix routes decryption through decryptToken(),
 * which tries the current key then SECRET_ENCRYPTION_KEY_PREVIOUS (mirroring the org
 * path).
 *
 * secretEncryption + tokenEncryption + the HMAC verification run for real here so key
 * rotation and signature checking are genuinely exercised; only the DB / config / queue
 * / logging boundaries are mocked.
 */

// previousKey = the key the SRE secret was encrypted under; currentKey = the rotated primary.
const previousKey = generateEncryptionKey();
const currentKey = generateEncryptionKey();
const PLAINTEXT_SECRET = 'sre-webhook-signing-secret';
const REPO_SLUG = 'MillionOnMars/lumina5';

// Secret stored in the SRE config, encrypted under the now-previous key.
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

const mockGetSettingsValue = vi.fn();
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  adminSettingsRepository: {
    getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
  },
}));

// resolveWebhookSecret returns whatever is stored in the (mocked) config; the schema
// parse is a pass-through so the test controls the resolved secret directly.
const mockResolveWebhookSecret = vi.fn();
vi.mock('@bike4mind/common', () => ({
  SreAgentConfigSchema: { parse: (v: unknown) => v },
  resolveWebhookSecret: (...args: unknown[]) => mockResolveWebhookSecret(...args),
}));

vi.mock('@bike4mind/observability', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    Logger: vi.fn(function () {
      return logger;
    }),
  };
});

const mockDispatchIssueToSre = vi.fn().mockResolvedValue({ dispatched: true });
vi.mock('@server/integrations/github/sreWebhookDispatch', () => ({
  dispatchIssueToSre: (...args: unknown[]) => mockDispatchIssueToSre(...args),
  SreIssuePayloadSchema: { safeParse: (payload: unknown) => ({ success: true, data: payload }) },
}));

const mockDispatchReviewToSreRevision = vi.fn().mockResolvedValue({ dispatched: true });
vi.mock('@server/integrations/github/sreRevisionDispatch', () => ({
  dispatchReviewToSreRevision: (...args: unknown[]) => mockDispatchReviewToSreRevision(...args),
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
const handler = (await import('../../../../pages/api/webhooks/github/sre')).default;

function signPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function createReqRes(rawBody: string, signature: string) {
  const req = {
    method: 'POST',
    headers: {
      'x-github-event': 'issues',
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

describe('SRE webhook handler — secret decrypt with key rotation', () => {
  const rawBody = JSON.stringify({
    action: 'opened',
    issue: { number: 1, title: 't', body: 'b', labels: [] },
    repository: { full_name: REPO_SLUG },
    sender: { login: 'octocat' },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettingsValue.mockResolvedValue({});
    mockTryClaimForProcessing.mockResolvedValue({ claimed: true });
  });

  it('decrypts an SRE secret encrypted under the previous key and dispatches the event', async () => {
    mockResolveWebhookSecret.mockReturnValue(secretEncryptedWithPreviousKey);

    // GitHub signs with the plaintext secret; the handler must recover it via the previous key.
    const { req, res } = createReqRes(rawBody, signPayload(rawBody, PLAINTEXT_SECRET));

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDispatchIssueToSre).toHaveBeenCalledTimes(1);
  });

  it('returns 500 without dispatching when the secret cannot be decrypted under either key', async () => {
    const unknownKey = generateEncryptionKey();
    mockResolveWebhookSecret.mockReturnValue(encryptSecret(PLAINTEXT_SECRET, unknownKey));

    const { req, res } = createReqRes(rawBody, signPayload(rawBody, PLAINTEXT_SECRET));

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockDispatchIssueToSre).not.toHaveBeenCalled();
  });
});
