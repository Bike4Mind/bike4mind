import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  update: vi.fn(),
  findByAtlassianCloudId: vi.fn(),
  deleteConfig: vi.fn(),
  deleteSubs: vi.fn(),
  findOwnSub: vi.fn(),
  deleteSub: vi.fn(),
  findOneAndDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.delete = (fn: Handler) => {
      h.handlers.delete = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, update: h.update },
  jiraWebhookConfigRepository: { findByAtlassianCloudId: h.findByAtlassianCloudId, delete: h.deleteConfig },
  jiraWebhookSubscriptionRepository: {
    deleteByWebhookConfig: h.deleteSubs,
    findByUserAndConfig: h.findOwnSub,
    delete: h.deleteSub,
  },
}));
vi.mock('@bike4mind/database/ai', () => ({ McpServer: { findOneAndDelete: h.findOneAndDelete } }));
vi.mock('@bike4mind/common', () => ({ McpServerName: { Atlassian: 'atlassian' } }));
vi.mock('@server/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: (v: string) => v }));

await import('../disconnect');

const makeRes = () => {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
};

describe('DELETE /api/mcp-servers/atlassian/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ atlassianConnect: { resources: [{ id: 'cloud-1' }] } });
    h.findByAtlassianCloudId.mockResolvedValue({ id: 'jcfg-1', createdBy: 'user-1' });
    h.deleteSubs.mockResolvedValue(2);
    h.findOwnSub.mockImplementation(async (userId: string) => ({ id: `sub-${userId}` }));
  });

  it('cascades the shared webhook config only for its creator and removes only the caller own subscription otherwise', async () => {
    await h.handlers.delete({ user: { id: 'user-2' } }, makeRes());
    expect(h.deleteConfig).not.toHaveBeenCalled();
    expect(h.deleteSubs).not.toHaveBeenCalled();
    expect(h.deleteSub).toHaveBeenCalledTimes(1);
    expect(h.deleteSub).toHaveBeenCalledWith('sub-user-2');
    expect(h.update).toHaveBeenCalledWith({ id: 'user-2', atlassianConnect: null });

    h.deleteSub.mockClear();
    await h.handlers.delete({ user: { id: 'admin-1', isAdmin: true } }, makeRes());
    expect(h.deleteConfig).not.toHaveBeenCalled();
    expect(h.deleteSub).toHaveBeenCalledWith('sub-admin-1');

    h.deleteSub.mockClear();
    await h.handlers.delete({ user: { id: 'user-1' } }, makeRes());
    expect(h.deleteSubs).toHaveBeenCalledWith('jcfg-1');
    expect(h.deleteConfig).toHaveBeenCalledWith('jcfg-1');
    expect(h.deleteSub).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenLastCalledWith({ id: 'user-1', atlassianConnect: null });
  });

  it('still disconnects the user when they have no own subscription', async () => {
    h.findOwnSub.mockResolvedValue(null);
    const res = makeRes();
    await h.handlers.delete({ user: { id: 'user-2' } }, res);
    expect(h.deleteSub).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith({ id: 'user-2', atlassianConnect: null });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still disconnects the user and returns 200 when subscription cleanup rejects', async () => {
    h.findOwnSub.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await h.handlers.delete({ user: { id: 'user-2' } }, res);
    expect(h.update).toHaveBeenCalledWith({ id: 'user-2', atlassianConnect: null });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('cascades only the configs the caller created across resources', async () => {
    h.findById.mockResolvedValue({ atlassianConnect: { resources: [{ id: 'cloud-1' }, { id: 'cloud-2' }] } });
    h.findByAtlassianCloudId.mockImplementation(async (cloudId: string) =>
      cloudId === 'cloud-1' ? { id: 'jcfg-1', createdBy: 'user-1' } : { id: 'jcfg-2', createdBy: 'user-9' }
    );
    await h.handlers.delete({ user: { id: 'user-1' } }, makeRes());
    expect(h.deleteConfig).toHaveBeenCalledTimes(1);
    expect(h.deleteConfig).toHaveBeenCalledWith('jcfg-1');
    expect(h.deleteSub).toHaveBeenCalledTimes(1);
    expect(h.deleteSub).toHaveBeenCalledWith('sub-user-1');
  });
});
