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
    // Matches `lake()`'s org: the accept-time org re-check compares the two, so a fixture that left
    // this unset would make every accept case refuse on the org move rather than the case it tests.
    organizationId: 'org1',
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
type OrgFixture = {
  userId: string;
  managerId?: string;
  adminUserIds: string[];
  // `permissions` is what `isOrgMember`/`orgAclRowConfersMembership` read: a roster row with none
  // does not confer membership, so the accept-time owner-rung re-check must see real permissions.
  users: { userId: string; permissions?: readonly string[] }[];
};

const ORG: OrgFixture = {
  userId: 'billing',
  adminUserIds: [],
  users: [
    { userId: 'creator', permissions: ['read'] },
    { userId: 'recipient', permissions: ['read'] },
  ],
};

const makeAdapters = (
  over: {
    offer?: IDataLakeOwnershipOfferDocument | null;
    pending?: IDataLakeOwnershipOfferDocument | null;
    recipientOffers?: IDataLakeOwnershipOfferDocument[];
    lakeDoc?: IDataLakeDocument | null;
    grants?: IDataLakeAccessGrantDocument[];
    org?: OrgFixture | null;
    userExists?: boolean;
    /** Whether `users.findById` reports the platform-admin flag the accept-time re-check reads. */
    offererIsAdmin?: boolean;
    createError?: Error;
    resolveTo?: IDataLakeOwnershipOfferDocument | null;
  } = {}
) => {
  // Stateful so `expirePendingForLake` can actually retire the row a later `findPendingForLake` and a
  // `create` would otherwise still see - that is the whole behaviour finding 1 is about.
  let pending = over.pending ?? null;
  // The row `create` most recently wrote, so a test can run `offerLakeOwnership` then
  // `acceptLakeOwnershipOffer` on one adapters instance and have accept read the row the REAL gate
  // produced - `offeredVia` in particular, rather than a hand-written rung.
  let stored: IDataLakeOwnershipOfferDocument | null = over.offer ?? null;
  const create = vi.fn(async (input: Record<string, unknown>) => {
    stored = offerRow(input as never);
    return stored;
  });
  const resolve = vi.fn(async (id: string, toStatus: string) =>
    over.resolveTo === undefined ? offerRow({ id, status: toStatus as never, resolvedAt: new Date() }) : over.resolveTo
  );
  const findById = vi.fn(async () => stored ?? (over.offer === undefined ? offerRow() : over.offer));
  // Honours `asOf` exactly as the repository does: with one, a lapsed row is invisible; without one it
  // is returned raw (the "still holds the slot" read the old pre-check trusted).
  const findPendingForLake = vi.fn(async (_dataLakeId: string, asOf?: Date) => {
    if (!pending) return null;
    if (asOf && pending.expiresAt.getTime() <= asOf.getTime()) return null;
    return pending;
  });
  const listPendingForRecipient = vi.fn(async () => over.recipientOffers ?? []);
  const expirePendingForLake = vi.fn(async (_dataLakeId: string, asOf: Date) => {
    if (pending && pending.status === 'pending' && pending.expiresAt.getTime() <= asOf.getTime()) {
      pending = { ...pending, status: 'expired', resolvedAt: asOf };
      return 1;
    }
    return 0;
  });
  const upsertGrant = vi.fn(async (input: Record<string, unknown>) => grant(input as never));
  const update = vi.fn(async () => lake());
  const record = vi.fn(async () => ({}));
  const listByLake = vi.fn(async () => over.grants ?? []);
  const findByIdUser = vi.fn(async (id: string) =>
    over.userExists === false
      ? null
      : { id, name: id === 'recipient' ? 'Recipient Name' : 'Creator Name', isAdmin: over.offererIsAdmin ?? false }
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
    expirePendingForLake,
    findById,
    findByIdUser,
    listByLake,
    /** The live fixture row AFTER any retire, so a test can assert it is no longer pending. */
    getPending: () => pending,
    adapters: {
      db: {
        dataLakes: { findById: findByIdLake, update },
        dataLakeAccessGrants: { upsertGrant, listByLake },
        users: { findById: findByIdUser, findByIds },
        organizations: { findById: findByIdOrg },
        ownershipOffers: {
          create,
          findById,
          findPendingForLake,
          listPendingForRecipient,
          resolve,
          expirePendingForLake,
        },
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
        organizationId: 'org1',
        offeredByUserId: 'creator',
        recipientUserId: 'recipient',
        status: 'pending',
        priorOwnerUserIds: ['creator'],
        offeredVia: 'creator',
      })
    );
  });

  it('persists the offer-time principal and the lake organization', async () => {
    // The audit principal is resolved only by a route (it alone can tell an API key from a session),
    // so the service must carry it verbatim onto the offer for accept to attribute the transfer to.
    const { adapters, create } = makeAdapters();
    const actorWithKey: LakeTransferActor = {
      ...owner,
      auditPrincipal: { principalKind: 'apiKey', principalId: 'key-1', onBehalfOfUserId: 'creator' },
    };

    await offerLakeOwnership(actorWithKey, lake(), [], 'recipient', adapters);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org1',
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-1', onBehalfOfUserId: 'creator' },
      })
    );
  });

  it('retires an expired pending offer and opens a new one over it', async () => {
    // An expired row is invisible to every read but still occupies the partial unique index
    // and the raw pre-check, wedging the lake with no UI control able to clear it. The offer must
    // retire it, not refuse on it.
    const expired = offerRow({ expiresAt: new Date(Date.now() - 1000) });
    const { adapters, create, expirePendingForLake, getPending } = makeAdapters({ pending: expired });

    await offerLakeOwnership(owner, lake(), [], 'recipient', adapters);

    expect(create).toHaveBeenCalledTimes(1);
    expect(expirePendingForLake).toHaveBeenCalledWith('lake1', expect.any(Date));
    // The old row is no longer pending, so the one-live-offer slot is free for the new one.
    expect(getPending()?.status).toBe('expired');
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

    // Both grants name the OFFERER as the granter, not the recipient who happened to accept.
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'recipient', role: 'owner', grantedByUserId: 'creator' })
    );
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'creator', role: 'curator', grantedByUserId: 'creator' })
    );
    expect(result).toMatchObject({ newOwnerUserId: 'recipient', demotedUserIds: ['creator'] });
    // The resolution lands BEFORE the grant writes, so a lost race never reaches apply.
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(upsertGrant.mock.invocationCallOrder[0]);
    // The audit row names the OFFERER's authority and principal, not the recipient who accepted.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'transfer-ownership',
        manageRung: 'creator',
        principalKind: 'user',
        principalId: 'creator',
      })
    );
  });

  it('carries the offer-time API-key principal into the applied transfer', async () => {
    // The route resolved an API key at OFFER time; the accept must attribute the transfer to that
    // same principal, not to the recipient's session. Dropping the spread turns every one of these
    // fields back into the recipient's `user` id.
    const { adapters, upsertGrant, record } = makeAdapters({
      grants: [grant({ principalId: 'creator', role: 'owner' })],
      offer: offerRow({
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-1', onBehalfOfUserId: 'creator' },
      }),
    });

    await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);

    for (const principalId of ['recipient', 'creator']) {
      expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId, grantedByUserId: 'creator' }));
    }
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'apiKey',
        principalId: 'key-1',
        onBehalfOfUserId: 'creator',
      })
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

  describe('the owner-rung check admits what the OFFER gate admitted', () => {
    // The rung is picked owner-first, so an owner who was authorized as a platform admin or as the
    // team manager is recorded on `creator`/`grant-owner` and never on the admin rungs. The accept
    // re-check must admit the same arms the offer gate admitted. Each case below runs the REAL gate
    // first, so the rung is the one the gate chose.
    const ownerGrant = () => grant({ principalId: 'creator', role: 'owner' });

    it('accepts an offer from a platform-admin owner who is not on the org roster', async () => {
      const { adapters, upsertGrant } = makeAdapters({
        grants: [ownerGrant()],
        org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'recipient' }] },
        offererIsAdmin: true,
      });

      const offer = await offerLakeOwnership(
        { userId: 'creator', isAdmin: true, organizationIds: [] },
        lake(),
        [ownerGrant()],
        'recipient',
        adapters
      );
      expect(offer.offeredVia).toBe('grant-owner');

      await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);

      expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
    });

    it('accepts an offer from an owner whose only admin arm is the org managerId', async () => {
      const { adapters, upsertGrant } = makeAdapters({
        grants: [ownerGrant()],
        org: { userId: 'billing', managerId: 'creator', adminUserIds: [], users: [{ userId: 'recipient' }] },
      });

      const offer = await offerLakeOwnership(
        { userId: 'creator', isAdmin: false, administeredOrgIds: ['org1'], organizationIds: [] },
        lake(),
        [ownerGrant()],
        'recipient',
        adapters
      );
      expect(offer.offeredVia).toBe('grant-owner');

      await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);

      expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
    });

    it('still refuses an owner who has left the org and holds no admin arm', async () => {
      const { adapters, upsertGrant, resolve } = makeAdapters({
        grants: [ownerGrant()],
        org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'recipient' }] },
      });

      // The actor was on the roll when the offer was made (`organizationIds`), but the roster no
      // longer names them and no admin arm does - the owner grant outlived the membership.
      const offer = await offerLakeOwnership(
        { userId: 'creator', isAdmin: false, organizationIds: ['org1'] },
        lake(),
        [ownerGrant()],
        'recipient',
        adapters
      );
      expect(offer.offeredVia).toBe('grant-owner');

      await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
        /no longer a member of the organization/i
      );
      expect(resolve).not.toHaveBeenCalled();
      expect(upsertGrant).not.toHaveBeenCalled();
    });
  });

  it('a platform-admin offer survives the offerer leaving the organization', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      offer: offerRow({ offeredByUserId: 'root', offeredVia: 'platform-admin' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'recipient' }] },
      offererIsAdmin: true,
    });
    await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
  });

  it('refuses an org-admin offer once the offerer loses ADMIN rights', async () => {
    // The org-admin rung is granted through `administeredOrgIds` (billing owner / manager /
    // appointed admin), NOT roster membership. A demoted admin still on `users[]` must not be able to
    // demote an owner.
    const { adapters, upsertGrant, resolve } = makeAdapters({
      offer: offerRow({ offeredByUserId: 'orgAdmin', offeredVia: 'org-admin' }),
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'orgAdmin' }, { userId: 'recipient' }] },
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(/no longer an admin/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('still accepts an org-admin offer while the offerer keeps admin rights', async () => {
    // The control for the refusal above: same roster, but `adminUserIds` still names the offerer.
    const { adapters, upsertGrant } = makeAdapters({
      offer: offerRow({ offeredByUserId: 'orgAdmin', offeredVia: 'org-admin' }),
      org: { userId: 'billing', adminUserIds: ['orgAdmin'], users: [{ userId: 'recipient' }] },
      grants: [grant({ principalId: 'creator', role: 'owner' })],
    });
    await acceptLakeOwnershipOffer('recipient', 'offer1', adapters);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'recipient', role: 'owner' }));
  });

  it('refuses when the lake moved to PRIVATE after the offer', async () => {
    // `organizationId` is stored on the offer; a lake since made personal no longer matches,
    // and the org rungs that authorized the offer are gone.
    const { adapters, upsertGrant, resolve } = makeAdapters({
      offer: offerRow({ organizationId: 'org1' }),
      lakeDoc: lake({ organizationId: undefined }),
      grants: [grant({ principalId: 'creator', role: 'owner' })],
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
      /moved to a different organization/i
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses when the lake moved to a DIFFERENT organization after the offer', async () => {
    const { adapters, upsertGrant, resolve } = makeAdapters({
      offer: offerRow({ organizationId: 'org1' }),
      lakeDoc: lake({ organizationId: 'org2' }),
      grants: [grant({ principalId: 'creator', role: 'owner' })],
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
      /moved to a different organization/i
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a platform-admin offer once the offerer loses the admin flag', async () => {
    // `platform-admin` is a live claim on the flag, not a fact snapshotted with the offer.
    const { adapters, upsertGrant, resolve, findByIdUser } = makeAdapters({
      offer: offerRow({ offeredByUserId: 'root', offeredVia: 'platform-admin' }),
      offererIsAdmin: false,
    });
    await expect(acceptLakeOwnershipOffer('recipient', 'offer1', adapters)).rejects.toThrow(
      /no longer a platform admin/i
    );
    // The flag must be read from the OFFERER, not from whoever else the test happens to
    // make an admin. Without this pin, `findById(recipientUserId)` reads the same false flag and the
    // refusal is indistinguishable from the right one.
    expect(findByIdUser).toHaveBeenCalledWith('root');
    expect(resolve).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses when the recipient is no longer an org member', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      // The offerer still confers membership (so the check that fails is the RECIPIENT's, not the
      // offerer's): a roster row without membership permissions would now trip the owner-rung check.
      org: { userId: 'billing', adminUserIds: [], users: [{ userId: 'creator', permissions: ['read'] }] },
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
    expect(pending).toMatchObject({
      id: 'offer1',
      offeredByUserId: 'creator',
      recipientUserId: 'recipient',
      recipientName: 'Recipient Name',
    });
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
