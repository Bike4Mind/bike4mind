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
import '@pages/api/organizations/[id]/retention';

async function call(method: string, body?: unknown) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: 'org' }, body });
  return h.handlers[method](
    Object.assign(req, { user: { id: 'actor', isAdmin: false } }) as unknown as Request,
    res as unknown as Response
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ personal: false, retentionVersion: 2 });
  h.member.mockResolvedValue({});
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
    expect(h.save).toHaveBeenCalledWith('org', 'actor', { chats: 1, files: null, media: null }, 2, undefined);
  });
});
