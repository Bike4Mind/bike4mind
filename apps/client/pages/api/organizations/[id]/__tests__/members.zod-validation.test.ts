import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const addMember = vi.hoisted(() =>
  vi.fn(async () => ({
    user: { id: 'new-u', email: 'new@example.com', level: 'member' },
  }))
);
vi.mock('@bike4mind/services', () => ({
  organizationService: { addMember, getUsers: vi.fn() },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: any) => fn(),
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    toSafeUser: (u: any) => u,
    toSafeUsers: (u: any) => u,
    safeUserResponseSchema: { parse: (x: any) => x },
    safeUsersResponseSchema: { parse: (x: any) => x },
  };
});
vi.mock('@server/utils/respond', () => ({ respond: (_res: any, _schema: any, data: any) => data }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock('@server/utils/errors', () => ({
  BadRequestError: class extends Error {},
}));

import '@pages/api/organizations/[id]/members/index';

function makeReq(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'org-123' } });
  (req as any).user = { id: 'u1' };
  (req as any).ability = null;
  (req as any).body = body;
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/organizations/[id]/members -- Zod validation', () => {
  beforeEach(() => addMember.mockClear());

  it('accepts a real client payload with email (invite by email)', async () => {
    const { req, res } = makeReq({ email: 'new@example.com' });
    await mockRefs.postHandler!(req, res);
    expect(addMember).toHaveBeenCalledOnce();
    const body = addMember.mock.calls[0][1] as any;
    expect(body.email).toBe('new@example.com');
  });

  it('accepts a payload with userId (invite by id)', async () => {
    const { req, res } = makeReq({ userId: 'uid-abc' });
    await mockRefs.postHandler!(req, res);
    expect(addMember).toHaveBeenCalledOnce();
  });

  it('accepts force flag alongside email', async () => {
    const { req, res } = makeReq({ email: 'new@example.com', force: true });
    await mockRefs.postHandler!(req, res);
    expect(addMember).toHaveBeenCalledOnce();
  });

  it('strips unknown keys -- organizationId in body cannot override the path param', async () => {
    const { req, res } = makeReq({ email: 'new@example.com', organizationId: 'attacker-org' });
    await mockRefs.postHandler!(req, res);
    // body schema only allows userId, email, force -- organizationId stripped
    const calledBody = addMember.mock.calls[0][1] as any;
    // service is called with organizationId from req.query, not from body
    expect(calledBody.organizationId).toBe('org-123');
  });
});
