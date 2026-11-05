import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { MAX_BULK_ITEMS } from '@bike4mind/common';

// `any` below is deliberate test-mock plumbing, matching the sibling [id] handler tests.
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const mocks = vi.hoisted(() => ({
  acceptInvite: vi.fn(),
  refuseWholeInvite: vi.fn(),
  withTransaction: vi.fn((fn: () => unknown) => fn()),
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/services', () => ({
  sharingService: { acceptInvite: mocks.acceptInvite, refuseWholeInvite: mocks.refuseWholeInvite },
}));
vi.mock('@bike4mind/database', () => ({
  inviteRepository: {},
  Organization: {},
  organizationRepository: {},
  sessionRepository: {},
  projectRepository: {},
  fabFileRepository: { findById: vi.fn().mockResolvedValue(null) },
  userRepository: {},
  Project: { findById: vi.fn() },
  fileTagRepository: {},
  withTransaction: mocks.withTransaction,
  FabFile: {},
  Group: {},
  Session: {},
  User: {},
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: mocks.sendToClient }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://x' } } }));

import '@pages/api/invites/bulk';

const ID_A = '65a1f77bcf86cd7994390001';
const ID_B = '65a1f77bcf86cd7994390002';
const TOKEN_C = 'q3Vx_9-TzW1sYbN2kLmPoR4uAeHcJdFgXiZt7nE8w0s';

const invite = (id: string, type = 'Session') => ({
  id,
  type,
  documentId: `doc-${id}`,
  recipients: { pending: [], accepted: ['me@x.com', 'other@x.com'], refused: [] },
});

const call = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body: body as any });
  (req as any).user = { id: 'u1', email: 'me@x.com' };
  (req as any).ability = {};
  (req as any).logger = { warn: vi.fn() };
  await mockRefs.postHandler!(req, res);
  return res;
};

describe('POST /api/invites/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptInvite.mockImplementation(async (_userId: string, { id }: { id: string }) => invite(id));
    mocks.refuseWholeInvite.mockImplementation(async (_user: unknown, { id }: { id: string }) => invite(id));
  });

  it.each([
    ['an empty id list', { action: 'accept', ids: [] }],
    ['a non-array ids field', { action: 'accept', ids: ID_A }],
    ['an unknown action', { action: 'delete', ids: [ID_A] }],
    ['an id that is neither an ObjectId nor a token', { action: 'accept', ids: ['$where'] }],
    ['an over-long id', { action: 'accept', ids: ['a'.repeat(65)] }],
    ['more than MAX_BULK_ITEMS ids', { action: 'accept', ids: Array.from({ length: MAX_BULK_ITEMS + 1 }, () => ID_A) }],
  ])('rejects %s before touching any invite', async (_label, body) => {
    await expect(call(body)).rejects.toThrow();
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
    expect(mocks.sendToClient).not.toHaveBeenCalled();
  });

  it('accepts each invite in its own transaction, as the caller, and refetches once', async () => {
    const res = await call({ action: 'accept', ids: [ID_A, ID_B, TOKEN_C, ID_A] });

    expect(mocks.acceptInvite).toHaveBeenCalledTimes(3);
    expect(mocks.acceptInvite.mock.calls.map(c => c[0])).toEqual(['u1', 'u1', 'u1']);
    expect(mocks.withTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.sendToClient).toHaveBeenCalledTimes(1);

    const body = res._getJSONData();
    expect(body.okCount).toBe(3);
    expect(body.results.map((r: any) => r.id)).toEqual([ID_A, ID_B, TOKEN_C]);
    expect(JSON.stringify(body)).not.toContain('other@x.com');
  });

  it('reports a per-invite failure without rolling back or blocking the others', async () => {
    const forbidden = Object.assign(new Error('This invite was not sent to your account'), { statusCode: 403 });
    mocks.acceptInvite.mockImplementation(async (_userId: string, { id }: { id: string }) => {
      if (id === ID_B) throw forbidden;
      if (id === TOKEN_C) throw new Error('mongo exploded at host db-1');
      return invite(id);
    });

    const body = (await call({ action: 'accept', ids: [ID_A, ID_B, TOKEN_C] }))._getJSONData();

    expect(body.okCount).toBe(1);
    expect(body.results).toEqual([
      expect.objectContaining({ id: ID_A, ok: true, type: 'Session' }),
      { id: ID_B, ok: false, error: 'This invite was not sent to your account' },
      { id: TOKEN_C, ok: false, error: 'Could not accept invite' },
    ]);
    expect(mocks.sendToClient).toHaveBeenCalledTimes(1);
  });

  it('refuses through the whole-invite service path and marks a missing invite as failed', async () => {
    mocks.refuseWholeInvite.mockImplementation(async (_user: unknown, { id }: { id: string }) =>
      id === ID_B ? null : invite(id)
    );

    const body = (await call({ action: 'refuse', ids: [ID_A, ID_B] }))._getJSONData();

    expect(mocks.refuseWholeInvite).toHaveBeenCalledTimes(2);
    expect(mocks.refuseWholeInvite.mock.calls[0][0]).toMatchObject({ id: 'u1' });
    expect(body.results[1]).toEqual({ id: ID_B, ok: false, error: 'Invite not found' });
    expect(body.okCount).toBe(1);
  });

  it('skips the refetch when nothing succeeded', async () => {
    mocks.acceptInvite.mockRejectedValue(new Error('boom'));

    const body = (await call({ action: 'accept', ids: [ID_A] }))._getJSONData();

    expect(body.okCount).toBe(0);
    expect(mocks.sendToClient).not.toHaveBeenCalled();
  });
});
