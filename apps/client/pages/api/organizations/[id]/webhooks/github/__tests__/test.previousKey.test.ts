// @vitest-environment node
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findByOrganizationId: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));

vi.mock('@bike4mind/database/infra', () => ({
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { incrementCounterConditional: vi.fn(async () => ({ success: true })) },
}));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgPermission: vi.fn(async () => ({ id: 'org-1', name: 'Acme' })),
}));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: vi.fn(async () => ({ valid: true })),
  fetchPinned: h.fetchMock,
  SsrfError: class SsrfError extends Error {},
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));

await import('../test');

const secretFixture = 'webhook-secret-fixture';

describe('POST /api/organizations/[id]/webhooks/github/test with a secret stored under the previous encryption key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const currentKey = generateEncryptionKey();
    const previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = currentKey;
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    h.findByOrganizationId.mockResolvedValue({ id: 'cfg-1', secret: encryptSecret(secretFixture, previousKey) });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  it('signs the test ping with the decrypted secret', async () => {
    const res = { setHeader: vi.fn(), status: vi.fn(() => res), json: vi.fn(() => res) };
    const req = {
      query: { id: 'org-1' },
      user: { id: 'user-1' },
      body: { targetUrl: 'https://hooks.example.com/endpoint' },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    };

    await h.handler!(req, res);

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const init = h.fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    const timestamp = init.headers['X-Webhook-Timestamp'];
    const expected = crypto.createHmac('sha256', secretFixture).update(`${timestamp}.${init.body}`).digest('hex');
    expect(init.headers['X-Webhook-Signature-256']).toBe(`sha256=${expected}`);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, statusCode: 200 }));
  });
});
