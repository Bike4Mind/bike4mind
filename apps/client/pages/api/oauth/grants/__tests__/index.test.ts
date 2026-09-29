import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  grants: [] as any[],
  clientName: 'TestApp',
}));

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
    listActiveByUser: () => Promise.resolve(mockRefs.grants),
  },
  oauthClientRepository: {
    findByClientId: () => Promise.resolve({ name: mockRefs.clientName }),
  },
}));

import '../index';

describe('GET /api/oauth/grants', () => {
  beforeEach(() => {
    mockRefs.grants = [];
    mockRefs.clientName = 'TestApp';
  });

  it('returns an empty grants array when the user has no active grants', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ grants: [] });
  });

  it('returns enriched grants with clientName and grantedAt', async () => {
    mockRefs.grants = [
      { clientId: 'client-a', scopes: ['openid', 'profile'], createdAt: new Date('2026-01-01') },
    ];
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getData());
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0].clientName).toBe('TestApp');
    expect(body.grants[0].clientId).toBe('client-a');
    expect(body.grants[0].scopes).toEqual(['openid', 'profile']);
  });

  it('falls back to clientId as name when the client record is not found', async () => {
    mockRefs.grants = [
      { clientId: 'unknown-client', scopes: ['email'], createdAt: new Date('2026-01-01') },
    ];
    mockRefs.clientName = null as any;
    vi.doMock('@bike4mind/database', () => ({
      oauthGrantRepository: { listActiveByUser: () => Promise.resolve(mockRefs.grants) },
      oauthClientRepository: { findByClientId: () => Promise.resolve(null) },
    }));
    const { req, res } = createMocks({ method: 'GET' });
    req.user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    const body = JSON.parse(res._getData());
    expect(body.grants[0].clientName).toBe('unknown-client');
  });
});
