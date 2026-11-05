import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, InviteType, MAX_BULK_ITEMS } from '@bike4mind/common';

// `any` below is deliberate test-mock plumbing, matching the sibling invite route tests.
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  postMiddleware: [] as unknown[],
  gate: Symbol('outboundActionGate'),
}));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => mockRefs.gate,
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (...fns: any[]) => {
      mockRefs.postMiddleware = fns.slice(0, -1);
      mockRefs.postHandler = fns[fns.length - 1];
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  tryAddWithinLimitFixedWindow: vi.fn(),
  decrementCounter: vi.fn(),
  sendInviteNotificationEmails: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/services', () => ({ sharingService: { createInvite: mocks.createInvite } }));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({
  getInviteTypeName: () => 'file',
  sendInviteNotificationEmails: mocks.sendInviteNotificationEmails,
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryAddWithinLimitFixedWindow: mocks.tryAddWithinLimitFixedWindow,
    decrementCounter: mocks.decrementCounter,
  },
  User: { find: () => ({ collation: () => ({ lean: () => Promise.resolve([]) }) }) },
  FabFile: { findById: () => Promise.resolve({ fileName: 'report.pdf' }) },
  Group: { findById: vi.fn() },
  Session: { findById: () => Promise.resolve({ name: 'Notes' }) },
  Organization: {},
  withTransaction: (fn: any) => fn(),
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
  organizationRepository: {},
  projectRepository: {},
  inviteRepository: {},
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));

import '@pages/api/invites/batch';

const ID_A = '65a1f77bcf86cd7994390001';
const ID_B = '65a1f77bcf86cd7994390002';
const ID_C = '65a1f77bcf86cd7994390003';
const FITS = { success: true, expiresAt: new Date(Date.now() + 60_000) };
const REFUSED = { success: false, expiresAt: new Date(Date.now() + 60_000) };

const body = (overrides: Record<string, unknown> = {}) => ({
  type: InviteType.FabFile,
  ids: [ID_A, ID_B],
  permissions: ['read', 'share'],
  recipients: ['friend@test.com'],
  ...overrides,
});

const call = async (requestBody: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body: requestBody as any });
  (req as any).user = { id: 'u1', email: 'me@test.com', name: 'Me' };
  (req as any).ability = {};
  (req as any).logger = { warn: vi.fn(), error: vi.fn() };
  await mockRefs.postHandler!(req, res);
  return res;
};

describe('POST /api/invites/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryAddWithinLimitFixedWindow.mockResolvedValue(FITS);
    mocks.createInvite.mockImplementation(async (_user: unknown, { id }: { id: string }) => ({
      id: `inv-${id}`,
      token: `tok-${id}`,
      documentId: id,
      type: InviteType.FabFile,
      recipients: { pending: [], accepted: [], refused: [] },
    }));
  });

  it('runs behind the outbound action gate', () => {
    expect(mockRefs.postMiddleware).toEqual([mockRefs.gate]);
  });

  it.each([
    ['no ids', body({ ids: [] })],
    ['non-array ids', body({ ids: ID_A })],
    ['a non-ObjectId id', body({ ids: [ID_A, 'nope'] })],
    ['more than MAX_BULK_ITEMS ids', body({ ids: Array.from({ length: MAX_BULK_ITEMS + 1 }, () => ID_A) })],
    ['a project invite type', body({ type: InviteType.Project })],
    ['a group invite type', body({ type: InviteType.Group })],
    ['no permissions field', body({ permissions: undefined })],
  ])('rejects %s with a 400 before creating anything', async (_label, requestBody) => {
    await expect(call(requestBody)).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.createInvite).not.toHaveBeenCalled();
    expect(mocks.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('creates one invite per deduped id, with the body type and id authoritative', async () => {
    const res = await call(body({ ids: [ID_A, ID_B, ID_A], type: InviteType.Session }));

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.createInvite).toHaveBeenCalledTimes(2);
    expect(mocks.createInvite.mock.calls[0][1]).toEqual(
      expect.objectContaining({ id: ID_A, type: InviteType.Session, recipients: ['friend@test.com'] })
    );
    const json = res._getJSONData();
    expect(json.okCount).toBe(2);
    expect(json.results).toEqual([
      { id: ID_A, ok: true, link: expect.stringMatching(/\/share\/tok-65a1f77bcf86cd7994390001$/) },
      { id: ID_B, ok: true, link: expect.stringMatching(/\/share\/tok-65a1f77bcf86cd7994390002$/) },
    ]);
    expect(json.rateLimitMessage).toBeUndefined();
  });

  it('reserves the send budget per item, as the single-item route does', async () => {
    await call(body({ ids: [ID_A, ID_B, ID_C] }));
    expect(mocks.tryAddWithinLimitFixedWindow).toHaveBeenCalledTimes(3);
    expect(mocks.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:u1:invite-recipients',
      1,
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('fails only the item the service refuses and releases that item budget', async () => {
    mocks.createInvite.mockImplementation(async (_user: unknown, { id }: { id: string }) => {
      if (id === ID_A) throw new ForbiddenError('You cannot share this document');
      return { id: `inv-${id}`, token: `tok-${id}`, recipients: { pending: [] } };
    });

    const json = (await call(body()))._getJSONData();

    expect(json.results[0]).toEqual({ id: ID_A, ok: false, error: 'You cannot share this document' });
    expect(json.results[1]).toEqual(expect.objectContaining({ id: ID_B, ok: true }));
    expect(json.okCount).toBe(1);
    expect(mocks.decrementCounter).toHaveBeenCalledTimes(1);
  });

  it('keeps an unexpected server error generic', async () => {
    mocks.createInvite.mockRejectedValueOnce(new Error('connection reset by 10.0.0.5'));
    const json = (await call(body({ ids: [ID_A] })))._getJSONData();
    expect(json.results).toEqual([{ id: ID_A, ok: false, error: 'Could not share' }]);
  });

  it('stops at the first send-budget refusal and marks the rest rate limited without trying them', async () => {
    mocks.tryAddWithinLimitFixedWindow.mockResolvedValueOnce(FITS).mockResolvedValueOnce(REFUSED);

    const json = (await call(body({ ids: [ID_A, ID_B, ID_C] })))._getJSONData();

    expect(mocks.tryAddWithinLimitFixedWindow).toHaveBeenCalledTimes(2);
    expect(mocks.createInvite).toHaveBeenCalledTimes(1);
    expect(json.okCount).toBe(1);
    expect(json.rateLimitMessage).toBe('Too many invitations. Try again later.');
    expect(json.results.slice(1)).toEqual([
      { id: ID_B, ok: false, rateLimited: true, error: 'Too many invitations. Try again later.' },
      { id: ID_C, ok: false, rateLimited: true, error: 'Too many invitations. Try again later.' },
    ]);
  });
});
