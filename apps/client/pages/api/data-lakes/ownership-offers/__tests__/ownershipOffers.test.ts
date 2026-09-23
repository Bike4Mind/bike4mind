import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listLakeOwnershipOffersForRecipient: vi.fn(),
  acceptLakeOwnershipOffer: vi.fn(),
  declineLakeOwnershipOffer: vi.fn(),
  sendEmail: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'recipient', isAdmin: false, administeredOrgIds: [] })),
  inTransaction: [] as string[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    listLakeOwnershipOffersForRecipient: h.listLakeOwnershipOffersForRecipient,
    acceptLakeOwnershipOffer: h.acceptLakeOwnershipOffer,
    declineLakeOwnershipOffer: h.declineLakeOwnershipOffer,
    // See the sibling transfer-ownership route test: the real renderer is pure, and these tests
    // assert WHO was emailed, not the copy (covered by renderOwnershipOfferEmail.test.ts).
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
  dataLakeAccessGrantRepository: {},
  dataLakeOwnershipOfferRepository: {},
  userRepository: { findById: vi.fn().mockResolvedValue({ id: 'creator', email: 'creator@example.com' }) },
  organizationRepository: {},
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {},
}));
vi.mock('@server/utils/mailer', () => ({ default: { sendEmail: h.sendEmail } }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import offersHandler from '../index';
import acceptHandler from '../[offerId]/accept';
import declineHandler from '../[offerId]/decline';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (method: string, query: Record<string, string> = {}) =>
  ({ method, query, user: { id: 'recipient', name: 'Rita Recipient' } }) as never;
const call = (handler: unknown, r: unknown, res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const OFFER = {
  id: 'offer-1',
  dataLakeId: 'lake-oid-1',
  offeredByUserId: 'creator',
  recipientUserId: 'recipient',
  status: 'pending',
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  priorOwnerUserIds: ['creator'],
  offeredVia: 'creator',
};

describe('GET /api/data-lakes/ownership-offers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the CALLER pending offers', async () => {
    h.listLakeOwnershipOffersForRecipient.mockResolvedValue([
      { id: 'offer-1', dataLakeId: 'lake-oid-1', lakeName: 'Lake One', expiresAt: OFFER.expiresAt },
    ]);
    const { res, json } = makeRes();

    await call(offersHandler, req('GET'), res);

    expect(h.listLakeOwnershipOffersForRecipient).toHaveBeenCalledWith('recipient', expect.anything());
    expect(json).toHaveBeenCalledWith({ data: [expect.objectContaining({ id: 'offer-1' })] });
  });
});

describe('POST /api/data-lakes/ownership-offers/:offerId/accept', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'recipient', isAdmin: false, administeredOrgIds: [] });
    h.acceptLakeOwnershipOffer.mockResolvedValue({
      newOwnerUserId: 'recipient',
      demotedUserIds: ['creator'],
      offer: OFFER,
    });
  });

  it('accepts as the AUTHENTICATED recipient and returns the applied transfer', async () => {
    h.inTransaction.length = 0;
    h.acceptLakeOwnershipOffer.mockImplementation(async () => {
      h.inTransaction.push('accept');
      return { newOwnerUserId: 'recipient', demotedUserIds: ['creator'], offer: OFFER };
    });
    const { res, json } = makeRes();

    await call(acceptHandler, req('POST', { offerId: 'offer-1' }), res);

    expect(h.acceptLakeOwnershipOffer).toHaveBeenCalledWith(
      'recipient',
      'offer-1',
      expect.objectContaining({ db: expect.anything() })
    );
    // The resolution and the grant writes are one transaction.
    expect(h.inTransaction).toEqual(['enter', 'accept', 'exit']);
    expect(json).toHaveBeenCalledWith({ data: { newOwnerUserId: 'recipient', demotedUserIds: ['creator'] } });
  });

  it('emails the offerer after commit', async () => {
    const { res } = makeRes();
    await call(acceptHandler, req('POST', { offerId: 'offer-1' }), res);
    expect(h.sendEmail).toHaveBeenCalledWith(
      'creator@example.com',
      expect.objectContaining({ subject: expect.stringContaining('accepted') })
    );
  });

  it('propagates the not-found refusal for a non-recipient', async () => {
    h.acceptLakeOwnershipOffer.mockRejectedValue(new Error('Ownership offer not found'));
    const { res } = makeRes();
    await expect(call(acceptHandler, req('POST', { offerId: 'offer-1' }), res)).rejects.toThrow(/not found/i);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/data-lakes/ownership-offers/:offerId/decline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'recipient', isAdmin: false, administeredOrgIds: [] });
    h.declineLakeOwnershipOffer.mockResolvedValue({ ...OFFER, status: 'declined' });
  });

  it('declines as the authenticated recipient and returns the closed offer', async () => {
    const { res, json } = makeRes();
    await call(declineHandler, req('POST', { offerId: 'offer-1' }), res);
    expect(h.declineLakeOwnershipOffer).toHaveBeenCalledWith('recipient', 'offer-1', expect.anything());
    expect(json).toHaveBeenCalledWith({ data: { id: 'offer-1', status: 'declined' } });
  });

  it('emails the offerer after commit, and never on a refusal', async () => {
    const { res } = makeRes();
    await call(declineHandler, req('POST', { offerId: 'offer-1' }), res);
    expect(h.sendEmail).toHaveBeenCalledWith(
      'creator@example.com',
      expect.objectContaining({ subject: expect.stringContaining('declined') })
    );

    h.sendEmail.mockClear();
    h.declineLakeOwnershipOffer.mockRejectedValue(new Error('Ownership offer not found'));
    await expect(call(declineHandler, req('POST', { offerId: 'offer-x' }), makeRes().res)).rejects.toThrow(
      /not found/i
    );
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});
