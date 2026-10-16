import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  searchAccessible: vi.fn(),
  refreshAgentAvatarUrls: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return { post: () => ({}) };
    },
  }),
}));

vi.mock('@bike4mind/database', () => ({ agentRepository: { searchAccessible: h.searchAccessible } }));
vi.mock('@server/agents/createAgent', () => ({ createAgent: vi.fn() }));
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls: h.refreshAgentAvatarUrls }));

await import('../index');

describe('GET /api/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.refreshAgentAvatarUrls.mockImplementation(async (agents: unknown[]) => agents);
    h.searchAccessible.mockResolvedValue({
      data: [
        { id: 'mine', userId: 'viewer', tavernSessionId: 'session-mine' },
        { id: 'shared', userId: 'other', tavernSessionId: 'session-shared', users: [{ userId: 'viewer' }] },
      ],
      total: 2,
    });
  });

  it("strips tavernSessionId from shared agents, keeping the caller's own", async () => {
    const json = vi.fn();
    await h.handler!({ user: { id: 'viewer' }, query: {} }, { json });

    const { data, total } = json.mock.calls[0][0];
    expect(total).toBe(2);
    expect(data[0]).toMatchObject({ id: 'mine', tavernSessionId: 'session-mine' });
    expect(data[1]).toMatchObject({ id: 'shared' });
    expect(data[1]).not.toHaveProperty('tavernSessionId');
  });
});
