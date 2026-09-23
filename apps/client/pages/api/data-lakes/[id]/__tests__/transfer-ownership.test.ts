import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeAccessWithGrants: vi.fn(),
  offerLakeOwnership: vi.fn(),
  cancelLakeOwnershipOffer: vi.fn(),
  findPendingLakeOwnershipOffer: vi.fn(),
  listLakeOwnershipCandidates: vi.fn(),
  resolveLakeTransferAuthority: vi.fn(),
  sendEmail: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false, administeredOrgIds: [] })),
  // Records what ran inside the transaction callback, so the ordering assertions below are about
  // the real boundary rather than about the mock having been imported.
  inTransaction: [] as string[],
}));

// baseApi mock: callable chain routed by req.method (same shape as the sibling endpoint tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeAccessWithGrants: h.assertLakeAccessWithGrants,
    offerLakeOwnership: h.offerLakeOwnership,
    cancelLakeOwnershipOffer: h.cancelLakeOwnershipOffer,
    findPendingLakeOwnershipOffer: h.findPendingLakeOwnershipOffer,
    listLakeOwnershipCandidates: h.listLakeOwnershipCandidates,
    resolveLakeTransferAuthority: h.resolveLakeTransferAuthority,
    // The real renderer is pure; the route test only needs to know the notifier reached the mailer,
    // so a thumbprint subject keeps the assertion about WHO was emailed, not about the copy.
    renderOwnershipOfferEmail: (input: { kind: string }) => ({
      subject:
        input.kind === 'offered' ? 'You have been offered ownership of "Lake One"' : `Ownership offer ${input.kind}`,
      html: '',
    }),
  },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => unknown) => {
    h.inTransaction.push('enter');
    try {
      return await fn();
    } finally {
      h.inTransaction.push('exit');
    }
  },
  dataLakeRepository: { findById: vi.fn().mockResolvedValue({ id: 'lake-oid-1', name: 'Lake One' }) },
  // The config-audit + offer repos this route wires. Stubbed rather than omitted because the mock
  // replaces the whole module: a missing export is an import-time failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]), upsertGrant: vi.fn() },
  dataLakeOwnershipOfferRepository: {},
  // The notifier looks the addressee + lake name up here.
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'recipient', email: 'recipient@example.com' }) },
  organizationRepository: {},
  // NotifierTest: the real notifier is exercised below, so its mailer is stubbed at the transport.
}));
vi.mock('@server/utils/mailer', () => ({ default: { sendEmail: h.sendEmail } }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../transfer-ownership';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (method: string, query: Record<string, string>, body?: unknown) =>
  ({ method, query, body, user: { id: 'u1', name: 'Olive Owner' } }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

// The write gate's return value, forwarded WHOLE to the service.
const LAKE = { id: 'lake-oid-1', slug: 'my-lake' };
const GRANTS = [{ principalType: 'user', principalId: 'u9', role: 'owner' }];
const OFFER = {
  id: 'offer-1',
  dataLakeId: 'lake-oid-1',
  recipientUserId: 'newOwner',
  offeredByUserId: 'u1',
  status: 'pending',
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  priorOwnerUserIds: ['u1'],
  offeredVia: 'creator',
};

describe('POST /api/data-lakes/[id]/transfer-ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.offerLakeOwnership.mockResolvedValue(OFFER);
  });

  it('creates a PENDING OFFER against the resolved lake and returns it', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: GRANTS });
    const { res, json } = makeRes();

    await call(req('POST', { id: 'my-lake' }, { newOwnerUserId: 'newOwner' }), res);

    expect(h.offerLakeOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      LAKE,
      GRANTS,
      'newOwner',
      expect.objectContaining({ db: expect.objectContaining({ ownershipOffers: expect.anything() }) })
    );
    expect(json).toHaveBeenCalledWith({ offer: expect.objectContaining({ id: 'offer-1' }) });
  });

  it('emails the recipient after the offer commits', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: GRANTS });
    const { res } = makeRes();

    await call(req('POST', { id: 'my-lake' }, { newOwnerUserId: 'newOwner' }), res);

    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][0]).toBe('recipient@example.com');
    expect(h.sendEmail.mock.calls[0][1]).toMatchObject({ subject: expect.stringContaining('offered ownership') });
  });

  it('sends the email AFTER the transaction, never inside it', async () => {
    h.inTransaction.length = 0;
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: GRANTS });
    h.sendEmail.mockImplementation(async () => {
      h.inTransaction.push('email');
      return {};
    });

    await call(req('POST', { id: 'lake1' }, { newOwnerUserId: 'newOwner' }), makeRes().res);

    expect(h.inTransaction).toEqual(['enter', 'exit', 'email']);
  });

  it('still returns the offer when the mailer throws (best-effort mail)', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: GRANTS });
    h.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const { res, json } = makeRes();

    await call(req('POST', { id: 'lake1' }, { newOwnerUserId: 'newOwner' }), res);

    expect(json).toHaveBeenCalledWith({ offer: expect.objectContaining({ id: 'offer-1' }) });
  });

  it('does not offer when the access gate denies the lake', async () => {
    h.assertLakeAccessWithGrants.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'lake1' }, { newOwnerUserId: 'x' }), res)).rejects.toThrow(/not found/i);
    expect(h.offerLakeOwnership).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('takes the acting principal from the access context, never from the request body', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: { id: 'lake1' }, grants: [] });
    const { res } = makeRes();

    await call(req('POST', { id: 'lake1' }, { newOwnerUserId: 'newOwner', userId: 'attacker', isAdmin: true }), res);

    expect(h.offerLakeOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      { id: 'lake1' },
      [],
      'newOwner',
      expect.anything()
    );
  });

  it('rejects a missing newOwnerUserId (schema validation)', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: { id: 'lake1' }, grants: [] });
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'lake1' }, {}), res)).rejects.toThrow();
    expect(h.offerLakeOwnership).not.toHaveBeenCalled();
  });

  it('reads the grants and writes the offer inside one transaction', async () => {
    h.inTransaction.length = 0;
    h.assertLakeAccessWithGrants.mockImplementation(async () => {
      h.inTransaction.push('gate');
      return { lake: LAKE, grants: GRANTS };
    });
    h.offerLakeOwnership.mockImplementation(async () => {
      h.inTransaction.push('offer');
      return OFFER;
    });

    await call(req('POST', { id: 'lake1' }, { newOwnerUserId: 'u9' }), makeRes().res);

    expect(h.inTransaction.slice(0, 4)).toEqual(['enter', 'gate', 'offer', 'exit']);
  });
});

describe('DELETE /api/data-lakes/[id]/transfer-ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    h.cancelLakeOwnershipOffer.mockResolvedValue({ ...OFFER, status: 'cancelled' });
  });

  it('cancels the pending offer behind the resolved lake gate and returns it', async () => {
    h.assertLakeAccessWithGrants.mockResolvedValue({ lake: LAKE, grants: GRANTS });
    const { res, json } = makeRes();

    await call(req('DELETE', { id: 'my-lake' }), res);

    expect(h.cancelLakeOwnershipOffer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      LAKE,
      GRANTS,
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ offer: expect.objectContaining({ status: 'cancelled' }) });
  });

  it('does not cancel when the access gate denies the lake', async () => {
    h.assertLakeAccessWithGrants.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('DELETE', { id: 'lake1' }), res)).rejects.toThrow(/not found/i);
    expect(h.cancelLakeOwnershipOffer).not.toHaveBeenCalled();
  });
});

describe('GET /api/data-lakes/[id]/transfer-ownership', () => {
  const getReq = (query: Record<string, string>) => req('GET', query);

  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
    // The GET now takes the grants with the lake, so the pending-offer disclosure can decide whether
    // the caller could have made the offer without a second query.
    h.assertLakeAccessWithGrants.mockResolvedValue({
      lake: { id: 'lake-oid-1', organizationId: 'orgA' },
      grants: [],
    });
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: true, isOwner: false, viaOrgAdminOnly: false });
    h.listLakeOwnershipCandidates.mockResolvedValue({
      scope: 'organization',
      organizationName: 'Acme',
      candidates: [{ userId: 'u9', name: 'Carol', email: 'carol@example.com' }],
    });
    h.findPendingLakeOwnershipOffer.mockResolvedValue(null);
  });

  it('resolves candidates against the RESOLVED lake and returns the pending offer alongside', async () => {
    h.findPendingLakeOwnershipOffer.mockResolvedValue({
      id: 'offer-1',
      recipientUserId: 'u9',
      recipientName: 'Carol',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    const { res, json } = makeRes();

    await call(getReq({ id: 'my-lake' }), res);

    expect(h.listLakeOwnershipCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake-oid-1' }),
      expect.objectContaining({ userId: 'u1' }),
      expect.anything()
    );
    expect(h.findPendingLakeOwnershipOffer).toHaveBeenCalledWith('lake-oid-1', expect.anything());
    expect(json).toHaveBeenCalledWith({
      data: {
        scope: 'organization',
        organizationName: 'Acme',
        candidates: [{ userId: 'u9', name: 'Carol', email: 'carol@example.com' }],
      },
      pendingOffer: expect.objectContaining({ id: 'offer-1', recipientUserId: 'u9' }),
    });
  });

  it('does not disclose a lake the caller cannot even read', async () => {
    h.assertLakeAccessWithGrants.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();
    await expect(call(getReq({ id: 'lake1' }), res)).rejects.toThrow(/not found/i);
    expect(h.listLakeOwnershipCandidates).not.toHaveBeenCalled();
  });

  it('hides the pending offer from a caller who could not transfer the lake', async () => {
    // The pending row names the next owner, so a reader gets the candidate list (empty for
    // them) but never the offer.
    h.findPendingLakeOwnershipOffer.mockResolvedValue({
      id: 'offer-1',
      recipientUserId: 'u9',
      recipientName: 'Carol',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: false, isOwner: false, viaOrgAdminOnly: false });
    const { res, json } = makeRes();

    await call(getReq({ id: 'my-lake' }), res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ pendingOffer: null }));
  });

  it('shows the pending offer to its own recipient even without transfer authority', async () => {
    h.findPendingLakeOwnershipOffer.mockResolvedValue({
      id: 'offer-1',
      offeredByUserId: 'u9',
      recipientUserId: 'u1',
      recipientName: 'Olive',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: false, isOwner: false, viaOrgAdminOnly: false });
    const { res, json } = makeRes();

    await call(getReq({ id: 'my-lake' }), res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ pendingOffer: expect.objectContaining({ id: 'offer-1' }) })
    );
  });

  it('shows the pending offer to its OFFERER even after they lose transfer authority', async () => {
    // The offerer can still cancel it (DELETE allows them), so the control that does that must be
    // reachable from the dialog.
    h.findPendingLakeOwnershipOffer.mockResolvedValue({
      id: 'offer-1',
      offeredByUserId: 'u1',
      recipientUserId: 'u9',
      recipientName: 'Carol',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    h.resolveLakeTransferAuthority.mockReturnValue({ allowed: false, isOwner: false, viaOrgAdminOnly: false });
    const { res, json } = makeRes();

    await call(getReq({ id: 'my-lake' }), res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ pendingOffer: expect.objectContaining({ id: 'offer-1' }) })
    );
  });

  it('returns the empty list the service resolved rather than turning it into an error', async () => {
    h.listLakeOwnershipCandidates.mockResolvedValue({ scope: 'organization', candidates: [] });
    const { res, json } = makeRes();
    await call(getReq({ id: 'lake1' }), res);
    expect(json).toHaveBeenCalledWith({
      data: { scope: 'organization', candidates: [] },
      pendingOffer: null,
    });
  });
});
