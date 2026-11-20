import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { InviteType, NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => unknown),
  flag: null as unknown,
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: (fn: unknown) => {
      refs.flag = fn;
      return chain;
    },
    delete: (...fns: unknown[]) => {
      refs.handler = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (name: string) => ({ flag: name }),
}));

const mocks = vi.hoisted(() => ({ findInvite: vi.fn(), markRevoked: vi.fn(), loadManagedSpace: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  inviteRepository: { findById: mocks.findInvite, markRevoked: mocks.markRevoked },
}));
vi.mock('@server/spaces/spaceAccess', () => ({
  loadManagedSpace: mocks.loadManagedSpace,
  toSpaceInviteLinkView: (invite: { id: string }) => ({ id: invite.id }),
}));

import '@pages/api/spaces/[id]/invite-links/[inviteId]';

const SPACE_ID = '65a1f77bcf86cd7994390010';
const LINK = {
  id: 'link-1',
  documentId: SPACE_ID,
  type: InviteType.Space,
  isLinkOnly: true,
  remaining: 3,
  recipients: {},
};

const revoke = async () => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: SPACE_ID, inviteId: 'link-1' } });
  (req as unknown as { user: unknown }).user = { id: 'u-owner' };
  await refs.handler!(req, res);
  return res;
};

describe('DELETE /api/spaces/[id]/invite-links/[inviteId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadManagedSpace.mockResolvedValue({ id: SPACE_ID });
  });

  it('sits behind the EnableSpaces flag', () => {
    expect(refs.flag).toEqual({ flag: 'EnableSpaces' });
  });

  it.each([
    ['another Space', { ...LINK, documentId: '65a1f77bcf86cd7994390099' }],
    ['a named Space invite', { ...LINK, isLinkOnly: false, recipients: { pending: ['a@x.com'] } }],
    ['an organization link', { ...LINK, type: InviteType.Organization }],
    ['an unknown id', null],
  ])('404s %s without revoking', async (_label, invite) => {
    mocks.findInvite.mockResolvedValue(invite);
    await expect(revoke()).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.markRevoked).not.toHaveBeenCalled();
  });

  it('does not reach the invite when the caller cannot manage the Space', async () => {
    mocks.loadManagedSpace.mockRejectedValue(new NotFoundError('Space not found'));
    await expect(revoke()).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.findInvite).not.toHaveBeenCalled();
  });

  it('revokes this Space link and returns its view', async () => {
    mocks.findInvite.mockResolvedValue(LINK);
    mocks.markRevoked.mockResolvedValue({ ...LINK, revokedAt: new Date() });
    const res = await revoke();
    expect(mocks.markRevoked).toHaveBeenCalledWith('link-1');
    expect(res._getJSONData()).toEqual({ id: 'link-1' });
  });
});
