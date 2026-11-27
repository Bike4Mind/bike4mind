import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findByAtlassianCloudId: vi.fn(),
  update: vi.fn(),
  countByWebhookConfig: vi.fn(),
  getValidTokens: vi.fn(),
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
  jiraWebhookConfigRepository: {
    findByAtlassianCloudId: h.findByAtlassianCloudId,
    update: h.update,
  },
  jiraWebhookSubscriptionRepository: { countByWebhookConfig: h.countByWebhookConfig },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: h.getValidTokens },
  AtlassianReconnectRequiredError: class extends Error {},
}));

await import('../index');

const secretFixture = 'webhook-secret-fixture';

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

describe('Jira webhook config with a secret stored under the previous encryption key', () => {
  let storedConfig: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    const currentKey = generateEncryptionKey();
    const previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = currentKey;
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    storedConfig = {
      id: 'jcfg-1',
      atlassianCloudId: 'cloud-1',
      atlassianSiteUrl: 'https://site.example.net',
      routingToken: 'rt-1',
      secret: encryptSecret(secretFixture, previousKey),
      events: ['jira:issue_created'],
      createdBy: 'user-1',
      enabled: true,
    };
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  it('GET returns the masked secret', async () => {
    const res = makeRes();

    await h.handlers.get({ user: { id: 'user-1' }, query: {} }, res);

    const body = res.json.mock.calls[0][0] as { secret?: string; secretMasked: string };
    expect(body.secretMasked).toBe('*'.repeat(secretFixture.length - 4) + secretFixture.slice(-4));
    expect(body.secret).toBeUndefined();
  });

  it('PUT returns the masked secret after an update that leaves it untouched', async () => {
    const res = makeRes();

    await h.handlers.put({ user: { id: 'user-1' }, body: { enabled: false } }, res);

    const body = res.json.mock.calls[0][0] as { secret?: string; secretMasked: string };
    expect(body.secretMasked).toBe('*'.repeat(secretFixture.length - 4) + secretFixture.slice(-4));
    expect(body.secret).toBeUndefined();
  });
});
