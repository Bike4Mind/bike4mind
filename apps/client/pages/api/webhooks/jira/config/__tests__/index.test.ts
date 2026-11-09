import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findByAtlassianCloudId: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteConfig: vi.fn(),
  deleteSubs: vi.fn(),
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
    create: h.create,
    delete: h.deleteConfig,
  },
  jiraWebhookSubscriptionRepository: {
    countByWebhookConfig: h.countByWebhookConfig,
    deleteByWebhookConfig: h.deleteSubs,
  },
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: (value: string) => `enc(${value})`,
  decryptSecret: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
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
    const res = makeRes();
    await h.handlers.put({ user: { id: 'user-1' }, body: { enabled: false } }, res);
    expect(res.json.mock.calls[0][0].secret).toBeUndefined();

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jcfg-1', enabled: false });
  });

  it('writes only events when only events is sent', async () => {
    await h.handlers.put({ user: { id: 'user-1' }, body: { events: ['jira:issue_updated'] } }, makeRes());

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'jcfg-1', events: ['jira:issue_updated'] });
  });
});

describe('GET /api/webhooks/jira/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  const get = async (user: { id: string; isAdmin?: boolean }, query: Record<string, string>) => {
    const res = makeRes();
    await h.handlers.get({ user, query }, res);
    return res.json.mock.calls[0][0] as { secret?: string; secretMasked?: string };
  };

  it('returns only a masked secret regardless of caller or query', async () => {
    for (const user of [{ id: 'user-1' }, { id: 'admin-1', isAdmin: true }, { id: 'user-2' }]) {
      for (const query of [{}, { revealSecret: 'true' }, { secret: 'true' }]) {
        const body = await get(user, query);
        expect(body.secret).toBeUndefined();
        expect(body.secretMasked).toMatch(/^\*+cret$/);
        expect(JSON.stringify(body)).not.toContain('old-secret');
      }
    }
  });
});

describe('PUT and DELETE /api/webhooks/jira/config by a user who cannot manage the config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1' });
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    h.countByWebhookConfig.mockResolvedValue(0);
    h.deleteSubs.mockResolvedValue(0);
  });

  it('refuses PUT with 403 and writes nothing', async () => {
    await expect(h.handlers.put({ user: { id: 'user-2' }, body: { enabled: false } }, makeRes())).rejects.toMatchObject(
      { statusCode: 403 }
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it('refuses DELETE with 403 and deletes nothing', async () => {
    await expect(h.handlers.delete({ user: { id: 'user-2' } }, makeRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.deleteSubs).not.toHaveBeenCalled();
    expect(h.deleteConfig).not.toHaveBeenCalled();
  });

  it('lets an admin update and delete', async () => {
    await h.handlers.put({ user: { id: 'admin-1', isAdmin: true }, body: { enabled: false } }, makeRes());
    expect(h.update).toHaveBeenCalledTimes(1);
    await h.handlers.delete({ user: { id: 'admin-1', isAdmin: true } }, makeRes());
    expect(h.deleteConfig).toHaveBeenCalledWith('jcfg-1');
  });
});

describe('Jira config one-time secret responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getValidTokens.mockResolvedValue({ cloudId: 'cloud-1', siteUrl: 'https://site.example.net' });
    h.countByWebhookConfig.mockResolvedValue(0);
  });

  it('returns the generated secret on creation and stores its encrypted value', async () => {
    h.findByAtlassianCloudId.mockResolvedValue(null);
    h.create.mockImplementation(async (config: Record<string, unknown>) => ({ ...config, id: 'jcfg-1' }));
    const res = makeRes();

    await h.handlers.post({ user: { id: 'user-1' }, body: {} }, res);

    const response = res.json.mock.calls[0][0] as { secret: string; secretMasked: string };
    expect(response.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ secret: `enc(${response.secret})` }));
    expect(response.secretMasked).toBe('*'.repeat(60) + response.secret.slice(-4));
  });

  it('returns a fresh secret on rotation and preserves the encrypted previous secret', async () => {
    h.findByAtlassianCloudId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    const res = makeRes();

    await h.handlers.put({ user: { id: 'user-1' }, body: { rotateSecret: true } }, res);

    const response = res.json.mock.calls[0][0] as { secret: string; secretMasked: string; isRotating: boolean };
    expect(response.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'jcfg-1',
        secret: `enc(${response.secret})`,
        previousSecret: storedConfig.secret,
      })
    );
    expect(response.secretMasked).toBe('*'.repeat(60) + response.secret.slice(-4));
    expect(response.isRotating).toBe(true);
  });
});
