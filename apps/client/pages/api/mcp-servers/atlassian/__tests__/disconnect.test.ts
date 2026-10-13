import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  findById: vi.fn(),
  update: vi.fn(),
  findByAtlassianCloudId: vi.fn(),
  deleteConfig: vi.fn(),
  deleteSubs: vi.fn(),
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
  jiraWebhookSubscriptionRepository: { deleteByWebhookConfig: h.deleteSubs },
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
  });

  it('removes a shared webhook config only for its creator or an admin, and always removes the own connection', async () => {
    await h.handlers.delete({ user: { id: 'user-2' } }, makeRes());
    expect(h.deleteConfig).not.toHaveBeenCalled();
    expect(h.deleteSubs).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith({ id: 'user-2', atlassianConnect: null });

    await h.handlers.delete({ user: { id: 'user-1' } }, makeRes());
    expect(h.deleteSubs).toHaveBeenCalledWith('jcfg-1');
    expect(h.deleteConfig).toHaveBeenCalledWith('jcfg-1');
    expect(h.update).toHaveBeenLastCalledWith({ id: 'user-1', atlassianConnect: null });

    h.deleteConfig.mockClear();
    await h.handlers.delete({ user: { id: 'admin-1', isAdmin: true } }, makeRes());
    expect(h.deleteConfig).toHaveBeenCalledWith('jcfg-1');
  });
});
