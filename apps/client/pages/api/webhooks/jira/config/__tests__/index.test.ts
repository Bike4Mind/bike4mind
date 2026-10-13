import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('PUT /api/webhooks/jira/config without rotateSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  it('writes only enabled, with no secret keys', async () => {
    await h.handlers.put({ user: { id: 'user-1' }, body: { enabled: false } }, makeRes());

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jcfg-1', enabled: false });
  });

  it('writes only events when only events is sent', async () => {
    await h.handlers.put({ user: { id: 'user-1' }, body: { events: ['jira:issue_updated'] } }, makeRes());

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jcfg-1', events: ['jira:issue_updated'] });
  });
});

describe('GET /api/webhooks/jira/config with revealSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  const get = async (user: { id: string; isAdmin?: boolean }) => {
    const res = makeRes();
    await h.handlers.get({ user, query: { revealSecret: 'true' } }, res);
    return res.json.mock.calls[0][0] as { secret?: string; secretMasked?: string };
  };

  it('reveals the secret to the config creator or an admin only', async () => {
    expect((await get({ id: 'user-1' })).secret).toBe('old-secret');
    expect((await get({ id: 'admin-1', isAdmin: true })).secret).toBe('old-secret');

    const other = await get({ id: 'user-2' });
    expect(other.secret).toBeUndefined();
    expect(other.secretMasked).toBeDefined();
    expect(other.secretMasked).not.toContain('old-secret');
  });
});
