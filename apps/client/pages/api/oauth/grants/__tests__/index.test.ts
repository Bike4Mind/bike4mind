import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockRefs, mockListActiveByUser, mockFindByClientIds } = vi.hoisted(() => {
  const mockListActiveByUser = vi.fn();
  const mockFindByClientIds = vi.fn();
  return {
    mockRefs: {
      getHandler: null as null | ((req: any, res: any) => unknown),
      grants: [] as any[],
      clientName: 'TestApp' as string | null,
    },
    mockListActiveByUser,
    mockFindByClientIds,
  };
});

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@bike4mind/database', () => ({
  oauthGrantRepository: {
    listActiveByUser: mockListActiveByUser,
  },
  oauthClientRepository: {
    findByClientIds: mockFindByClientIds,
  },
}));

import '../index';

describe('GET /api/oauth/grants', () => {
  beforeEach(() => {
    mockRefs.grants = [];
    mockRefs.clientName = 'TestApp';
    mockListActiveByUser.mockResolvedValue(mockRefs.grants);
    mockFindByClientIds.mockImplementation((clientIds: string[]) =>
      Promise.resolve(
        new Map(
          clientIds
            .filter(() => mockRefs.clientName !== null)
            .map(id => [id, { name: mockRefs.clientName }])
        )
      )
    );
  });

  it('returns an empty grants array when the user has no active grants', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ grants: [] });
  });

  it('scopes the grant query to the caller -- listActiveByUser is called with req.user.id', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(mockListActiveByUser).toHaveBeenCalledWith('u1');
  });

  it('returns enriched grants with clientName and approvedAt', async () => {
    const grant = {
      clientId: 'client-a',
      scopes: ['openid', 'profile'],
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-06-15'),
    };
    mockListActiveByUser.mockResolvedValue([grant]);
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getData());
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0].clientName).toBe('TestApp');
    expect(body.grants[0].clientId).toBe('client-a');
    expect(body.grants[0].scopes).toEqual(['openid', 'profile']);
    expect(body.grants[0].approvedAt).toBe(new Date('2026-06-15').toISOString());
  });

  it('falls back to clientId as name when the client record is missing from the map', async () => {
    mockListActiveByUser.mockResolvedValue([
      { clientId: 'unknown-client', scopes: ['email'], updatedAt: new Date('2026-01-01') },
    ]);
    mockRefs.clientName = null;
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    const body = JSON.parse(res._getData());
    expect(body.grants[0].clientName).toBe('unknown-client');
  });
});
