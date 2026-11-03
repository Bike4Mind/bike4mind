import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => unknown;

interface MockChain {
  get: (fn: RouteHandler) => MockChain;
  post: () => MockChain;
  delete: () => MockChain;
}

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  getAttachedAgents: vi.fn(),
  findById: vi.fn(),
  refreshAgentAvatarUrls: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: MockChain = {
    get: fn => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: RouteHandler) => fn }));
vi.mock('@bike4mind/server-utils/utils/sessionAccess', () => ({ assertSessionAccess: vi.fn() }));
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls: mockRefs.refreshAgentAvatarUrls }));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { getAttachedAgents: mockRefs.getAttachedAgents },
  agentRepository: { findById: mockRefs.findById },
  sessionAgentConfigRepository: {},
  withTransaction: vi.fn(),
}));

await import('../agents');

const OWNER_ONLY_FIELDS = {
  systemPrompt: 'secret prompt',
  currentCredits: 500,
  memoryJournal: [{ id: 'm1' }],
  worldMemory: [{ id: 'w1' }],
  pendingMessages: [{ id: 'p1' }],
  tavernSessionId: 'session-1',
  users: [{ userId: 'someone', permissions: ['read'] }],
};

describe('GET /api/sessions/[id]/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.refreshAgentAvatarUrls.mockImplementation(async (agents: unknown[]) => agents);
    mockRefs.getAttachedAgents.mockResolvedValue(['mine', 'theirs']);
    mockRefs.findById.mockImplementation(async (id: string) => ({
      id,
      userId: id === 'mine' ? 'viewer' : 'other',
      name: `agent-${id}`,
      ...OWNER_ONLY_FIELDS,
    }));
  });

  // A session can hold agents the caller does not own and was never shared, so this is the widest
  // read path for owner-only agent fields.
  it("returns attached agents the caller does not own through the viewer allowlist, keeping the caller's own whole", async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'session-1' } });
    Object.assign(req, { user: { id: 'viewer' } });

    await mockRefs.getHandler!(req as unknown as Request, res as unknown as Response);

    const { agents } = res._getJSONData();
    expect(agents[0]).toEqual({ id: 'mine', userId: 'viewer', name: 'agent-mine', ...OWNER_ONLY_FIELDS });
    expect(agents[1]).toMatchObject({ id: 'theirs', name: 'agent-theirs' });
    for (const field of Object.keys(OWNER_ONLY_FIELDS)) expect(agents[1]).not.toHaveProperty(field);
  });
});
