import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  options: undefined as unknown,
  access: vi.fn(),
  member: vi.fn(),
  estimate: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.options = options;
    const chain = {
      get: (fn: Handler) => {
        h.handlers.GET = fn;
        return chain;
      },
      post: (fn: Handler) => {
        h.handlers.POST = fn;
        return chain;
      },
      put: (fn: Handler) => {
        h.handlers.PUT = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgAccess: h.access,
  verifyOrgMemberOrManager: h.member,
}));
vi.mock('@bike4mind/server-utils/organizations/retentionPolicy', () => ({
  createRetentionEstimate: h.estimate,
  saveRetentionPolicy: h.save,
}));
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import '@pages/api/organizations/[id]/retention';

const orgId = 'abcdefabcdefabcdefabcdef';
const subjectId = '123456781234567812345678';

async function call(method: string, body?: unknown, id: string | string[] = orgId, impersonatedBy?: string) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id }, body });
  return h.handlers[method](
    Object.assign(req, {
      user: { id: subjectId, isAdmin: false, ...(impersonatedBy ? { impersonatedBy } : {}) },
    }) as unknown as Request,
    res as unknown as Response
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ id: orgId, personal: false, retentionVersion: 2 });
  h.member.mockResolvedValue({ id: orgId });
});
describe('retention route authorization', () => {
  it('requires first-party session authentication', () => expect(h.options).toEqual({ auth: 'jwtOnly' }));
  it('allows member policy reads without admin authority', async () => {
    await call('GET');
    expect(h.member).toHaveBeenCalled();
    expect(h.access).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT'])('rejects unauthorized %s before estimating or saving', async method => {
    h.access.mockRejectedValue(new Error('Organization not found'));
    await expect(call(method, { policy: { chats: 1, files: null, media: null }, version: 2 })).rejects.toThrow(
      'not found'
    );
    expect(h.estimate).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it('forwards only a validated policy and server actor', async () => {
    await call('PUT', { policy: { chats: 1, files: null, media: null }, version: 2 });
    expect(h.save).toHaveBeenCalledWith(
      orgId,
      subjectId,
      { chats: 1, files: null, media: null },
      2,
      undefined,
      undefined,
      { auditActorUserId: subjectId, canAdminister: expect.any(Function) }
    );
  });
  it.each(['GET', 'POST', 'PUT'])(
    'rejects malformed %s organization IDs before authorization or work',
    async method => {
      for (const invalid of ['not-an-id', [orgId, orgId]]) {
        await expect(call(method, undefined, invalid)).rejects.toThrow('Invalid organization id');
      }
      expect(h.access).not.toHaveBeenCalled();
      expect(h.member).not.toHaveBeenCalled();
      expect(h.estimate).not.toHaveBeenCalled();
      expect(h.save).not.toHaveBeenCalled();
    }
  );
  it('uses the verified canonical org for estimates and keeps impersonation separate from token ownership', async () => {
    const policy = { chats: 1, files: null, media: null };
    await call('POST', { policy, version: 2 }, orgId.toUpperCase());
    expect(h.estimate).toHaveBeenCalledWith(orgId, subjectId, 2, policy);
    const realActor = 'fedcbafedcbafedcbafedcba';
    await call('PUT', { policy, version: 2 }, orgId.toUpperCase(), realActor);
    expect(h.save).toHaveBeenCalledWith(orgId, subjectId, policy, 2, undefined, undefined, {
      auditActorUserId: realActor,
      canAdminister: expect.any(Function),
    });
  });
  it.each([
    ['zero days', { chats: 0, files: null, media: null }],
    ['string days', { chats: '30', files: null, media: null }],
    ['an unknown policy key', { chats: 1, files: null, media: null, extra: 1 }],
  ])('rejects a policy with %s', async (_name, policy) => {
    await expect(call('PUT', { policy, version: 2 })).rejects.toThrow();
    await expect(call('POST', { policy, version: 2 })).rejects.toThrow();
    expect(h.estimate).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each([
    ['an extra key', { extra: true }],
    ['a non-uuid token', { confirmationToken: 'not-a-uuid' }],
    ['a negative version', { version: -1 }],
  ])('rejects a body with %s', async (_name, patch) => {
    const body = { policy: { chats: 1, files: null, media: null }, version: 2, ...patch };
    await expect(call('PUT', body)).rejects.toThrow();
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT'])('keeps %s not-found and forbidden failures distinct', async method => {
    const body = { policy: { chats: 1, files: null, media: null }, version: 2 };
    h.access.mockRejectedValueOnce(new NotFoundError('Organization not found'));
    await expect(call(method, body)).rejects.toBeInstanceOf(NotFoundError);
    h.access.mockRejectedValueOnce(new ForbiddenError('Forbidden'));
    await expect(call(method, body)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('rejects estimating a personal organization', async () => {
    h.access.mockResolvedValue({ personal: true, retentionVersion: 0 });
    await expect(call('POST', { policy: { chats: 1, files: null, media: null }, version: 0 })).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(h.estimate).not.toHaveBeenCalled();
  });
  it('rejects a non-member GET without returning the policy', async () => {
    h.member.mockRejectedValue(new NotFoundError('Organization not found'));
    await expect(call('GET')).rejects.toBeInstanceOf(NotFoundError);
  });
});
