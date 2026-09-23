import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKE_OWNERSHIP_OFFER_TTL_DAYS, DATA_LAKES } from '@bike4mind/common';
import type {
  IDataLakeAccessGrantDocument,
  IDataLakeDocument,
  IDataLakeOwnershipOfferDocument,
} from '@bike4mind/common';
import {
  acceptLakeOwnershipOffer,
  cancelLakeOwnershipOffer,
  declineLakeOwnershipOffer,
  findPendingLakeOwnershipOffer,
  listLakeOwnershipOffersForRecipient,
  offerLakeOwnership,
} from './lakeOwnershipOffer';
import type { LakeTransferActor } from './lakeOwnershipCandidates';

const lake = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({ id: 'lake1', name: 'Lake One', createdByUserId: 'creator', organizationId: 'org1', ...over }) as IDataLakeDocument;

const grant = (over: Partial<IDataLakeAccessGrantDocument>): IDataLakeAccessGrantDocument =>
  ({
    dataLakeId: 'lake1',
    principalType: 'user',
    principalId: 'x',
    role: 'owner',
    grantedByUserId: 'g',
    ...over,
  }) as IDataLakeAccessGrantDocument;

const offerRow = (over: Partial<IDataLakeOwnershipOfferDocument> = {}): IDataLakeOwnershipOfferDocument =>
  ({
    id: 'offer1',
    dataLakeId: 'lake1',
    offeredByUserId: 'creator',
    recipientUserId: 'recipient',
    status: 'pending',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    resolvedAt: null,
    priorOwnerUserIds: ['creator'],
    offeredVia: 'creator',
    ...over,
  }) as IDataLakeOwnershipOfferDocument;

/** The roster every org-scoped case shares: both parties are members unless a test says otherwise. */
const ORG = { userId: 'billing', adminUserIds: [], users: [{ userId: 'creator' }, { userId: 'recipient' }] };

const makeAdapters = (
  over: {
    offer?: IDataLakeOwnershipOfferDocument | null;
    pending?: IDataLakeOwnershipOfferDocument | null;
    recipientOffers?: IDataLakeOwnershipOfferDocument[];
    lakeDoc?: IDataLakeDocument | null;
    grants?: IDataLakeAccessGrantDocument[];
    org?: typeof ORG | null;
    userExists?: boolean;
    createError?: Error;
    resolveTo?: IDataLakeOwnershipOfferDocument | null;
  } = {}
) => {
  const create = vi.fn(async (input: Record<string, unknown>) => offerRow(input as never));
  const resolve = vi.fn(async (id: string, toStatus: string) =>
    over.resolveTo === undefined ? offerRow({ id, status: toStatus as never, resolvedAt: new Date() }) : over.resolveTo
  );
  const findById = vi.fn(async () => (over.offer === undefined ? offerRow() : over.offer));
  const findPendingForLake = vi.fn(async () => over.pending ?? null);
  const listPendingForRecipient = vi.fn(async () => over.recipientOffers ?? []);
  const upsertGrant = vi.fn(async (input: Record<string, unknown>) => grant(input as never));
  const update = vi.fn(async () => lake());
  const record = vi.fn(async () => ({}));
  const listByLake = vi.fn(async () => over.grants ?? []);
  const findByIdUser = vi.fn(async (id: string) =>
    over.userExists === false ? null : { id, name: id === 'recipient' ? 'Recipient Name' : 'Creator Name' }
  );
  const findByIds = vi.fn(async (ids: string[]) => ids.map(id => ({ id, name: id })));
  const findByIdOrg = vi.fn(async () => (over.org === undefined ? ORG : over.org));
  const findByIdLake = vi.fn(async () => (over.lakeDoc === undefined ? lake() : over.lakeDoc));

  if (over.createError) create.mockRejectedValueOnce(over.createError);

  return {
    upsertGrant,
    update,
    record,
    create,
    resolve,
    findPendingForLake,
    findById,
    listByLake,
    adapters: {
      db: {
        dataLakes: { findById: findByIdLake, update },
        dataLakeAccessGrants: { upsertGrant, listByLake },
        users: { findById: findByIdUser, findByIds },
        organizations: { findById: findByIdOrg },
        ownershipOffers: { create, findById, findPendingForLake, listPendingForRecipient, resolve },
        lakeConfigChangeEvents: { record },
      },
    } as never,
  };
};

const owner: LakeTransferActor = { userId: 'creator', isAdmin: false, organizationIds: ['org1'] };

describe('offerLakeOwnership', () => {
  it('does NOT move ownership - no grant is written for the recipient', async () => {
    const { adapters, create, upsertGrant, update } = makeAdapters({ grants: [] });

    await offerLakeOwnership(owner, lake(), [], 'recipient', adapters);

    expect(upsertGrant).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake1',
        offeredByUserId: 'creator',
        recipientUserId: 'recipient',
        status: 'pending',
        priorOwnerUserIds: ['creator'],
        offeredVia: 'creator',
      })
    );
  });

  it('expires the offer after the shared TTL', async () => {
    const { adapters, create } = makeAdapters();
    const before = Date.now();

    await offerLakeOwnership(owner, lake(), [], 'recipient', adapters);

    const expiry = (create.mock.calls[0][0] as { expiresAt: Date }).expiresAt.getTime();
    const ttlMs = DATA_LAKE_OWNERSHIP_OFFER_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(expiry).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiry).toBeLessThanOrEqual(Date.now() + ttlMs);
  });

  it('refuses a second offer while one is pending', async () => {
    const { adapters, create } = makeAdapters({ pending: offerRow() });
    await expect(offerLakeOwnership(owner, lake(), [], 'recipient', adapters)).rejects.toThrow(
      /already has a pending/i
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('maps the partial-index race on create to the same actionable refusal', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: 11000 });
    const { adapters } = makeAdapters({ createError: dup });
    await expect(offerLakeOwnership(owner, lake(), [], 'recipient', adapters)).rejects.toThrow(
      /already has a pending/i
    );
  });

  describe('the existing transfer gate is preserved at OFFER time', () => {
    it('refuses a fallback (registry) lake', async () => {
      const registryLake = lake({ id: DATA_LAKES[0].id });
      const { adapters, create } = makeAdapters({ lakeDoc: registryLake });
      await expect(offerLakeOwnership(owner, registryLake, [], 'recipient', adapters)).rejects.toThrow(
        /built into the platform/i
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses an actor who is neither admin, effective owner, nor an admin of the lake org', async () => {
      const { adapters, create } = makeAdapters();
      await expect(
        offerLakeOwnership(
          { userId: 'stranger', isAdmin: false, organizationIds: [] },
          lake(),
          [],
          'recipient',
          adapters
        )
      ).rejects.toThrow(/do not have permission to transfer/i);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a personal lake for a non-admin and says what would unblock them', async () => {
      const { adapters, create } = makeAdapters({ lakeDoc: lake({ organizationId: undefined }) });
      await expect(
        offerLakeOwnership(owner, lake({ organizationId: undefined }), [], 'recipient', adapters)
      ).rejects.toThrow(/personal data lake cannot be transferred/i);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses an org admin offering the lake to THEMSELVES', async () => {
      const { adapters, create } = makeAdapters({
        lakeDoc: lake({ createdByUserId: 'departed' }),
        org: {
          userId: 'billing',
          adminUserIds: ['orgAdmin'],
          users: [{ userId: 'orgAdmin' }, { userId: 'recipient' }],
        },
      });
      await expect(
        offerLakeOwnership(
          { userId: 'orgAdmin', isAdmin: false, administeredOrgIds: ['org1'], organizationIds: ['org1'] },
          lake({ createdByUserId: 'departed' }),
          [],
          'orgAdmin',
          adapters
        )
      ).rejects.toThrow(/cannot transfer a data lake to themselves/i);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a recipient outside the owning organization', async () => {
      const { adapters, create } = makeAdapters({
        org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'creator' }] },
      });
      await expect(offerLakeOwnership(owner, lake(), [], 'recipient', adapters)).rejects.toThrow(
        /must belong to the organization/i
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a recipient that does not exist', async () => {
      const { adapters, create } = makeAdapters({ userExists: false });
      await expect(offerLakeOwnership(owner, lake(), [], 'ghost', adapters)).rejects.toThrow(/could not be found/i);
      expect(create).not.toHaveBeenCalled();
    });
  });
});

describe('acceptLakeOwnershipOffer', () => {
  it('applies the transfer: recipient becomes owner, prior owner becomes curator', async () => {
    const { adapters, upsertGrant, resolve, record } = makeAdapters({
      grants: [grant({ principalId: 'creator', role: 'owner' })],
    });

    const result = await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);

    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'creator', role: 'curator' }));
    expect(result).toMatchObject({ newOwnerUserId: 'recipient', demotedUserIds: ['creator'] });
    // The resolution lands BEFORE the grant writes, so a lost race never reaches apply.
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(upsertGrant.mock.invocationCallOrder[0]);
    // The audit row names the OFFERER's authority, not the recipient who accepted. `records` is the
    // config-change sink the apply half reaches through the same adapter.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transfer-ownership', manageRung: 'creator' })
    );
  });

  it('refuses a non-recipient with a not-found, writing nothing', async () => {
    const { adapters, upsertGrant, resolve } = makeAdapters();
    await expect(acceptLakeOwnershipOffer('someone-else', 'offer1', adapters)).rejects.toThrow(/not found/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses an expired offer', async () => {
    const { adapters, upsertGrant, resolve } = makeAdapters({
      offer: offerRow({ expiresAt: new Date(Date.now() - 1000) }),
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/expired/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a STALE offer when ownership moved after it was made', async () => {
    // The snapshot said the creator owned it; a second transfer has since made someone else owner.
    const { adapters, upsertGrant, resolve } = makeAdapters({
      grants: [grant({ principalId: 'someoneElse', role: 'owner' })],
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/changed after the offer/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses when the offerer has left the organization', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'recipient' }] },
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
      /no longer a member of the organization/i
    );
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('a platform-admin offer survives the offerer leaving the organization', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      offer: offerRow({ offeredByUserId: 'root', offeredVia: 'platform-admin' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'recipient' }] },
    });
    await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
  });

  it('refuses when the recipient is no longer an org member', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'creator' }] },
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
      /no longer a member of the organization/i
    );
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('a second accept is refused by the atomic resolve, and writes nothing', async () => {
    const { adapters, upsertGrant, resolve, record } = makeAdapters({ resolveTo: null });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/no longer open/i);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(upsertGrant).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an already-resolved offer', async () => {
    const { adapters, upsertGrant } = makeAdapters({ offer: offerRow({ status: 'accepted' }) });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/no longer open/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });
});

describe('declineLakeOwnershipOffer', () => {
  it('closes the offer without touching grants', async () => {
    const { adapters, resolve, upsertGrant } = makeAdapters();
    const declined = await declineLakeOwnershipOffer('recipient', 'offer1', adapters);
    expect(declined.status).toBe('declined');
    expect(resolve).toHaveBeenCalledWith('offer1', 'declined');
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a non-recipient with a not-found', async () => {
    const { adapters, resolve } = makeAdapters();
    await expect(declineLakeOwnershipOffer('someone-else', 'offer1', adapters)).rejects.toThrow(/not found/i);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an offer another caller already resolved', async () => {
    const { adapters } = makeAdapters({ resolveTo: null });
    await expect(declineLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/no longer open/i);
  });
});

describe('cancelLakeOwnershipOffer', () => {
  it('lets the offerer close their own pending offer without touching grants', async () => {
    const { adapters, resolve, upsertGrant } = makeAdapters({ pending: offerRow() });
    const cancelled = await cancelLakeOwnershipOffer(owner, lake(), [], adapters);
    expect(cancelled.status).toBe('cancelled');
    expect(resolve).toHaveBeenCalledWith('offer1', 'cancelled');
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a third party with no transfer authority', async () => {
    const { adapters, resolve } = makeAdapters({ pending: offerRow() });
    await expect(
      cancelLakeOwnershipOffer({ userId: 'stranger', isAdmin: false, organizationIds: [] }, lake(), [], adapters)
    ).rejects.toThrow(/permission to cancel/i);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('allows a platform admin to cancel someone else offer', async () => {
    const { adapters, resolve } = makeAdapters({ pending: offerRow() });
    await cancelLakeOwnershipOffer({ userId: 'root', isAdmin: true, organizationIds: [] }, lake(), [], adapters);
    expect(resolve).toHaveBeenCalledWith('offer1', 'cancelled');
  });

  it('404s when the lake has no pending offer', async () => {
    const { adapters } = makeAdapters({ pending: null });
    await expect(cancelLakeOwnershipOffer(owner, lake(), [], adapters)).rejects.toThrow(/no pending ownership offer/i);
  });
});

describe('reads', () => {
  it('findPendingLakeOwnershipOffer names the recipient', async () => {
    const { adapters } = makeAdapters({ pending: offerRow() });
    const pending = await findPendingLakeOwnershipOffer('lake1', adapters);
    expect(pending).toMatchObject({ id: 'offer1', recipientUserId: 'recipient', recipientName: 'Recipient Name' });
    expect(pending?.expiresAt).toBeInstanceOf(Date);
  });

  it('findPendingLakeOwnershipOffer is null with no live offer', async () => {
    const { adapters } = makeAdapters({ pending: null });
    expect(await findPendingLakeOwnershipOffer('lake1', adapters)).toBeNull();
  });

  it('listLakeOwnershipOffersForRecipient projects the narrow disclosure', async () => {
    const { adapters } = makeAdapters({
      recipientOffers: [offerRow({ dataLakeId: 'lake1' })],
      lakeDoc: lake({ requiredUserTag: 'team-x' }),
    });
    const summaries = await listLakeOwnershipOffersForRecipient('recipient', adapters);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'offer1',
      dataLakeId: 'lake1',
      lakeName: 'Lake One',
      gate: { requiredUserTag: 'team-x' },
    });
    // No files / system prompt / roster leaked into the recipient-facing shape.
    expect(Object.keys(summaries[0])).not.toContain('systemPrompt');
  });

  it('drops an offer whose lake is gone', async () => {
    const { adapters } = makeAdapters({ recipientOffers: [offerRow()], lakeDoc: null });
    expect(await listLakeOwnershipOffersForRecipient('recipient', adapters)).toEqual([]);
  });
});
