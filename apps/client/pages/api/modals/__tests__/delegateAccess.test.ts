import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ModalModel } from '@bike4mind/database/social';
import type { IUserDocument } from '@bike4mind/common';

// Drives the create and delete routes with the real request ability, so a settings:manage
// delegate is proven to pass the route's own `req.ability.can(...)` check end to end.
// `any` below is deliberate test-mock plumbing for the next-connect / node-mocks-http chain.
const handlers = vi.hoisted(() => ({
  post: null as null | ((req: any, res: any) => unknown),
  delete: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => ((handlers.post = fn), chain),
      delete: (fn: any) => ((handlers.delete = fn), chain),
    };
    return chain;
  },
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn(async () => null),
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

import defineAbilitiesFor from '@server/auth/ability';
import '@pages/api/modals/create';
import '@pages/api/modals/[id]/delete';

const MODAL_ID = '507f1f77bcf86cd799439011';

const user = (overrides: Partial<IUserDocument>) =>
  ({ id: 'u1', isAdmin: false, tags: [], groups: [], email: 'user@example.com', ...overrides }) as IUserDocument;

const delegate = user({ adminPermissions: ['settings:manage'] });
const nonDelegate = user({ adminPermissions: ['support:read'] });

function request(method: 'POST' | 'DELETE', who: IUserDocument) {
  const { req, res } = createMocks(
    method === 'POST'
      ? {
          method,
          body: {
            title: 'Demo',
            subtitle: null,
            textMessage: null,
            imageUrl: null,
            description: null,
            tags: null,
            startDate: null,
            endDate: null,
            numberOfAgrees: null,
            numberOfViews: null,
          },
        }
      : { method, query: { id: MODAL_ID } }
  );
  Object.assign(req, { user: who, ability: defineAbilitiesFor(who) });
  return { req, res };
}

describe('modal create/delete routes for a settings:manage delegate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ModalModel.prototype, 'save').mockResolvedValue(undefined as never);
    vi.spyOn(ModalModel, 'findOneAndDelete').mockResolvedValue({ _id: MODAL_ID, title: 'Demo' } as never);
  });

  it('lets a delegate create a modal', async () => {
    const { req, res } = request('POST', delegate);
    await handlers.post!(req, res);
    expect(res._getStatusCode()).toBe(201);
  });

  it('lets a delegate delete a modal', async () => {
    const { req, res } = request('DELETE', delegate);
    await handlers.delete!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(ModalModel.findOneAndDelete).toHaveBeenCalledWith({ _id: MODAL_ID });
  });

  it('denies create and delete to a user holding a different admin permission', async () => {
    const create = request('POST', nonDelegate);
    await expect(handlers.post!(create.req, create.res)).rejects.toThrow('Permission denied');
    const del = request('DELETE', nonDelegate);
    await expect(handlers.delete!(del.req, del.res)).rejects.toThrow('Permission denied');
    expect(ModalModel.prototype.save).not.toHaveBeenCalled();
    expect(ModalModel.findOneAndDelete).not.toHaveBeenCalled();
  });
});
