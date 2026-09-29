import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  incrementCredits: vi.fn(),
  countByUserId: vi.fn(),
  agentCreate: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: () => ({
      post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    }),
  }),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, incrementCredits: h.incrementCredits },
  agentRepository: { countByUserId: h.countByUserId, create: h.agentCreate },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls: vi.fn() }));

await import('../index');

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status }, json, status };
};

describe('POST /api/agents - credit allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: 'user-1', level: 'PaidUser', currentCredits: 100 });
    h.countByUserId.mockResolvedValue(0);
    h.agentCreate.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'agent-1', ...data }));
  });

  it('reports the persisted balance returned by the atomic decrement, not the stale in-memory one', async () => {
    // A concurrent spend moved the stored balance since the read: 100 - 30 in memory, but 50 in the DB.
    h.incrementCredits.mockResolvedValue({ id: 'user-1', currentCredits: 50 });
    const { res, json, status } = makeRes();

    await h.handler!({ user: { id: 'user-1' }, body: { name: 'Agent', useOwnCredits: true, currentCredits: 30 } }, res);

    expect(h.incrementCredits).toHaveBeenCalledWith('user-1', -30);
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ userCredits: 50 }));
  });
});
