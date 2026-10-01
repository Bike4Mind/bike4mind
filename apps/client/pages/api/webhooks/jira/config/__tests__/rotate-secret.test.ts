// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
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
  jiraWebhookConfigRepository: { findByAtlassianCloudId: h.findByAtlassianCloudId, update: h.update },
  jiraWebhookSubscriptionRepository: { countByWebhookConfig: h.countByWebhookConfig },
}));
vi.mock('@server/integrations/jira/webhookUtils', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/jira/webhookUtils')>()),
  generateWebhookSecret: () => 'new-plain-secret',
}));
vi.mock('@server/security/secretEncryption', () => ({
  encryptSecret: (value: string) => `enc(${value})`,
  decryptSecret: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: h.getValidTokens },
  AtlassianReconnectRequiredError: class extends Error {},
}));

await import('../index');
const { ROTATION_WINDOW_MS } = await import('@server/integrations/jira/webhookUtils');

const NOW = new Date('2026-01-01T00:00:00.000Z');

const storedConfig = {
  id: 'jcfg-1',
  atlassianCloudId: 'cloud-1',
  atlassianSiteUrl: 'https://site.example.net',
  routingToken: 'rt-1',
  secret: 'enc(old-secret)',
  events: ['jira:issue_created'],
  createdBy: 'user-1',
  enabled: true,
};

const makeRes = () => {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

describe('PUT /api/webhooks/jira/config rotateSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes exactly the rotated secret fields, keeping the old secret for the rotation window', async () => {
    const res = makeRes();

    await h.handlers.put({ user: { id: 'user-1' }, body: { rotateSecret: true } }, res);

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith({
      id: 'jcfg-1',
      previousSecret: 'enc(old-secret)',
      previousSecretExpiresAt: new Date(NOW.getTime() + ROTATION_WINDOW_MS).toISOString(),
      secret: 'enc(new-plain-secret)',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ secret: 'new-plain-secret', isRotating: true }));
  });

  it('refuses a non-creator without writing', async () => {
    await expect(
      h.handlers.put({ user: { id: 'someone-else' }, body: { rotateSecret: true } }, makeRes())
    ).rejects.toThrow(/Only the creator/);
    expect(h.update).not.toHaveBeenCalled();
  });
});
