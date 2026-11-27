import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

type Handler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findByOrganizationId: vi.fn(),
  update: vi.fn(),
  countByOrganization: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['get', 'put', 'post', 'delete']) {
    chain[method] = (fn: Handler) => {
      h.handlers[method] = fn;
      return chain;
    };
  }
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database/infra', () => ({
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId, update: h.update },
  webhookSubscriptionRepository: { countByOrganization: h.countByOrganization },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgPermission: vi.fn(async () => ({ id: 'org-1', name: 'Org' })),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn(async () => null) }));

import '@pages/api/organizations/[id]/webhooks/github';

const ORG_ID = '507f1f77bcf86cd799439011';
const secretFixture = 'webhook-secret-fixture';

const call = async (method: 'get' | 'put', query: Record<string, string>, body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: method === 'get' ? 'GET' : 'PUT', query: { id: ORG_ID, ...query }, body });
  Object.assign(req, { user: { id: 'owner1', isAdmin: false } });
  await h.handlers[method](req, res);
  return res;
};

describe('organization GitHub webhook config with a secret stored under the previous encryption key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const currentKey = generateEncryptionKey();
    const previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = currentKey;
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    const stored = {
      id: 'cfg1',
      organizationId: ORG_ID,
      routingToken: 'routing-token-fixture',
      repos: [],
      subscribedEvents: [],
      createdBy: 'owner1',
      enabled: true,
      secret: encryptSecret(secretFixture, previousKey),
    };
    h.findByOrganizationId.mockResolvedValue(stored);
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...stored, ...partial }));
    h.countByOrganization.mockResolvedValue(0);
  });

  it('GET returns the masked secret', async () => {
    const res = await call('get', {});

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().secretMasked).toBe('*'.repeat(secretFixture.length - 4) + secretFixture.slice(-4));
  });

  it('GET ignores revealSecret and still masks a previous-key secret', async () => {
    const res = await call('get', { revealSecret: 'true' });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().secret).toBeUndefined();
    expect(res._getJSONData().secretMasked).toBe('*'.repeat(secretFixture.length - 4) + secretFixture.slice(-4));
  });

  it('PUT returns the masked secret after an update that leaves it untouched', async () => {
    const res = await call('put', {}, { enabled: false });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().secretMasked).toBe('*'.repeat(secretFixture.length - 4) + secretFixture.slice(-4));
  });
});
