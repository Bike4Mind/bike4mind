import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | ((req: unknown, res: unknown) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: unknown) => {
      mockRefs.getHandler = fn as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const listAgentEmbedKeys = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { listAgentEmbedKeys },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
const agentFindById = vi.hoisted(() => vi.fn());
const findIdsAdministeredBy = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: agentFindById },
  organizationRepository: { findIdsAdministeredBy },
}));

import '@pages/api/agents/[id]/embed-keys';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

const OWNED_KEY = {
  id: 'key-1',
  name: 'Widget key',
  keyPrefix: 'b4m_live_abc1234',
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
  status: 'active',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  userId: 'u1',
  organizationId: undefined,
  keyHash: 'HASH_MUST_NEVER_LEAK',
  metadata: { clientIP: '203.0.113.7' },
};

function makeReq(query: Record<string, unknown>, user: Record<string, unknown> = { id: 'u1', isAdmin: false }) {
  const { req, res } = createMocks({ method: 'GET', query });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/agents/[id]/embed-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFindById.mockResolvedValue({ id: 'agent-1', userId: 'u1', organizationId: undefined });
    findIdsAdministeredBy.mockResolvedValue([]);
    listAgentEmbedKeys.mockResolvedValue([OWNED_KEY]);
  });

  it('rejects a missing, empty, or array-valued agent id with 400 before any lookup', async () => {
    for (const query of [{}, { id: '' }, { id: ['a', 'b'] }]) {
      const { req, res } = makeReq(query);
      await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    }
    expect(agentFindById).not.toHaveBeenCalled();
    expect(listAgentEmbedKeys).not.toHaveBeenCalled();
  });

  it('404s on an unknown agent', async () => {
    agentFindById.mockResolvedValue(null);
    const { req, res } = makeReq({ id: 'agent-x' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s (not 403) for a caller who neither owns the agent nor admins its org', async () => {
    agentFindById.mockResolvedValue({ id: 'agent-1', userId: 'someone-else', organizationId: 'org-9' });
    const { req, res } = makeReq({ id: 'agent-1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(listAgentEmbedKeys).not.toHaveBeenCalled();
  });

  it('an agent with neither owner nor org (both-unset row) is never visible to a non-admin', async () => {
    agentFindById.mockResolvedValue({ id: 'agent-1', userId: undefined, organizationId: undefined });
    const { req, res } = makeReq({ id: 'agent-1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns the owner a slim projection with no secret material', async () => {
    const { req, res } = makeReq({ id: 'agent-1' });
    await mockRefs.getHandler!(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (res as any)._getJSONData();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: 'key-1',
      keyPrefix: 'b4m_live_abc1234',
      allowedOrigins: ['https://example.com'],
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('HASH_MUST_NEVER_LEAK');
    expect(raw).not.toContain('203.0.113.7');
    expect(body[0].keyHash).toBeUndefined();
    expect(body[0].metadata).toBeUndefined();
  });

  it('lets an org admin of the agent org see the org-billed keys', async () => {
    agentFindById.mockResolvedValue({ id: 'agent-1', userId: 'someone-else', organizationId: 'org-1' });
    findIdsAdministeredBy.mockResolvedValue(['org-1']);
    listAgentEmbedKeys.mockResolvedValue([{ ...OWNED_KEY, userId: 'someone-else', organizationId: 'org-1' }]);
    const { req, res } = makeReq({ id: 'agent-1' });
    await mockRefs.getHandler!(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any)._getJSONData()).toHaveLength(1);
  });

  it('filters out a key with neither a matching owner nor an administered org (both-unset row)', async () => {
    listAgentEmbedKeys.mockResolvedValue([
      OWNED_KEY,
      { ...OWNED_KEY, id: 'key-2', userId: 'someone-else', organizationId: undefined },
      { ...OWNED_KEY, id: 'key-3', userId: undefined, organizationId: undefined },
    ]);
    const { req, res } = makeReq({ id: 'agent-1' });
    await mockRefs.getHandler!(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (res as any)._getJSONData();
    expect(body.map((k: { id: string }) => k.id)).toEqual(['key-1']);
  });

  it('lets a platform admin through both gates', async () => {
    agentFindById.mockResolvedValue({ id: 'agent-1', userId: 'someone-else', organizationId: undefined });
    listAgentEmbedKeys.mockResolvedValue([{ ...OWNED_KEY, userId: 'someone-else' }]);
    const { req, res } = makeReq({ id: 'agent-1' }, { id: 'admin-1', isAdmin: true });
    await mockRefs.getHandler!(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any)._getJSONData()).toHaveLength(1);
  });
});
