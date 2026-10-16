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

const OWNER_ONLY_FIELDS = {
  systemPrompt: 'secret prompt',
  currentCredits: 500,
  memoryJournal: [{ id: 'm1' }],
  worldMemory: [{ id: 'w1' }],
  pendingMessages: [{ id: 'p1' }],
  tavernSessionId: 'session-1',
};

describe('GET /api/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.refreshAgentAvatarUrls.mockImplementation(async (agents: unknown[]) => agents);
    h.searchAccessible.mockResolvedValue({
      data: [
        { id: 'mine', userId: 'viewer', ...OWNER_ONLY_FIELDS },
        { id: 'shared', userId: 'other', name: 'Shared', ...OWNER_ONLY_FIELDS, users: [{ userId: 'viewer' }] },
      ],
      total: 2,
    });
  });

  it("returns shared agents through the viewer allowlist, keeping the caller's own whole", async () => {
    const json = vi.fn();
    await h.handler!({ user: { id: 'viewer' }, query: {} }, { json });

    const { data, total } = json.mock.calls[0][0];
    expect(total).toBe(2);
    expect(data[0]).toEqual({ id: 'mine', userId: 'viewer', ...OWNER_ONLY_FIELDS });
    expect(data[1]).toMatchObject({ id: 'shared', name: 'Shared' });
    for (const field of Object.keys(OWNER_ONLY_FIELDS)) expect(data[1]).not.toHaveProperty(field);
    expect(data[1]).not.toHaveProperty('users');
    expect(data[1]).not.toHaveProperty('userId');
  });
});
