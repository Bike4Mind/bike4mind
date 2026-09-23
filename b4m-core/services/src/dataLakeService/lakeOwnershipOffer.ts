import type {
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeOwnershipOfferDocument,
  IDataLakeOwnershipOfferRepository,
  IDataLakeRepository,
  IOrganizationRepository,
  IUserRepository,
  LakeOwnershipOfferSummary,
  LakePendingOwnershipOffer,
} from '@bike4mind/common';
import { DATA_LAKE_OWNERSHIP_OFFER_TTL_DAYS } from '@bike4mind/common';
import { BadRequestError, NotFoundError, normalizeId } from '@bike4mind/utils';
import { resolveEffectiveOwnerIds, type LakeGrant } from './manageRule';
import {
  isOrgAdminOf,
  isOrgOwnershipCandidate,
  resolveLakeTransferAuthority,
  type LakeTransferActor,
} from './lakeOwnershipCandidates';
import { applyLakeOwnershipTransfer, authorizeLakeTransfer } from './transferLakeOwnership';
import type { LakeConfigAuditAdapters } from './recordLakeConfigChange';

/**
 * Everything the offer lifecycle reads or writes. One shape for all five entry points - they are one
 * feature reached through five routes, and narrowing per function would buy a reader nothing while
 * doubling the adapter types a test has to spell out.
 *
 * `lakeConfigChangeEvents` and `dataLakes.update` are the apply half's requirements (see
 * `ApplyLakeOwnershipTransferAdapters`), carried here because accept can reach apply.
 */
export interface LakeOwnershipOfferAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'update'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'upsertGrant' | 'listByLake'>;
    users: Pick<IUserRepository, 'findById' | 'findByIds'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
    ownershipOffers: Pick<
      IDataLakeOwnershipOfferRepository,
      'create' | 'findById' | 'findPendingForLake' | 'listPendingForRecipient' | 'resolve' | 'expirePendingForLake'
    >;
    lakeConfigChangeEvents: NonNullable<LakeConfigAuditAdapters['db']['lakeConfigChangeEvents']>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

const PENDING_ALREADY: string = 'This data lake already has a pending ownership offer; cancel it first';
const OFFER_CLOSED = 'This ownership offer is no longer open';

/**
 * Open a pending ownership offer. Ownership does NOT move here: this runs today's transfer gate
 * unchanged (`authorizeLakeTransfer`), then records the offer and stops. The effective owners are
 * snapshotted so accept can refuse an offer that another change has overtaken.
 */
export async function offerLakeOwnership(
  actor: LakeTransferActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  newOwnerUserId: string,
  { db }: LakeOwnershipOfferAdapters
): Promise<IDataLakeOwnershipOfferDocument> {
  // The whole authorization path is shared with the direct transfer, so the offer door can never
  // accept a recipient the transfer would reject (or vice versa).
  const { manageRung } = await authorizeLakeTransfer(actor, lake, grants, newOwnerUserId, { db });

  // Retire a lapsed offer BEFORE checking for a live one. An expired `pending` row is invisible to
  // every read but still trips both this pre-check (when read raw) and the model's partial unique
  // index, which keys on `status` alone - so without this an unanswered offer would wedge the lake
  // for good, with no UI control able to clear it. Resolving to `expired` frees the slot.
  const now = new Date();
  await db.ownershipOffers.expirePendingForLake(lake.id, now);

  // At most one live offer per lake. Checked here for the actionable error, and enforced again by
  // the model's partial unique index so a race between two offers is refused rather than queued.
  if (await db.ownershipOffers.findPendingForLake(lake.id, now)) {
    throw new BadRequestError(PENDING_ALREADY);
  }

  const expiresAt = new Date(now.getTime() + DATA_LAKE_OWNERSHIP_OFFER_TTL_DAYS * 24 * 60 * 60 * 1000);
  try {
    return await db.ownershipOffers.create({
      dataLakeId: lake.id,
      organizationId: normalizeId(lake.organizationId) ?? null,
      offeredByUserId: actor.userId,
      recipientUserId: newOwnerUserId,
      status: 'pending',
      expiresAt,
      resolvedAt: null,
      priorOwnerUserIds: resolveEffectiveOwnerIds(lake, grants),
      offeredVia: manageRung,
      ...(actor.auditPrincipal ? { auditPrincipal: actor.auditPrincipal } : {}),
    });
  } catch (err) {
    // E11000: lost the insert race to a concurrent offer for the same lake. Same actionable refusal
    // the pre-check gives, rather than a 500 for a state the caller can resolve the same way.
    if ((err as { code?: number }).code === 11000) throw new BadRequestError(PENDING_ALREADY);
    throw err;
  }
}

export interface AcceptLakeOwnershipOfferResult {
  newOwnerUserId: string;
  demotedUserIds: string[];
  /** The resolved offer row, so the caller can email the offerer without a second read. */
  offer: IDataLakeOwnershipOfferDocument;
}

/**
 * Apply an offer's transfer, as the RECIPIENT. The whole point of the pending state: ownership moves
 * only here, and only when the person it was offered to says yes.
 *
 * Re-validates at accept time rather than trusting the offer:
 *  - pending and unexpired;
 *  - the lake's effective owners still equal the snapshot (another transfer, or a departure
 *    succession, since the offer makes it STALE and it is refused rather than applied over it);
 *  - the lake still belongs to the organization it did at offer time;
 *  - the offerer still holds the authority the offer was made under: current ADMIN rights for the
 *    org-admin rung (not mere roster membership, which the offer-time gate never granted it), current
 *    membership for the ownership rungs, current platform-admin for that rung;
 *  - the recipient is still a member of the lake's organization.
 *
 * The offer is resolved `pending -> accepted` BEFORE the grants are written. `resolve` is atomic on
 * the status, so a concurrent accept loses and refuses rather than running the transfer twice; and
 * because the route wraps this in one transaction, a failure in the apply half rolls the resolution
 * back too - never an accepted offer with no transfer behind it.
 */
export async function acceptLakeOwnershipOffer(
  recipientUserId: string,
  offerId: string,
  { db, logger }: LakeOwnershipOfferAdapters
): Promise<AcceptLakeOwnershipOfferResult> {
  const offer = await db.ownershipOffers.findById(offerId);
  // Not-found-style refusal for anyone but the named recipient: an offer's existence is disclosed to
  // its recipient alone.
  if (!offer || offer.recipientUserId !== recipientUserId) {
    throw new NotFoundError('Ownership offer not found');
  }
  if (offer.status !== 'pending') {
    throw new BadRequestError(OFFER_CLOSED);
  }
  const now = new Date();
  if (offer.expiresAt.getTime() <= now.getTime()) {
    throw new BadRequestError('This ownership offer has expired');
  }

  const lake = await db.dataLakes.findById(offer.dataLakeId);
  if (!lake) {
    throw new BadRequestError('The data lake this offer is for no longer exists');
  }

  // Active as of NOW, not as of the offer: an owner grant that lapsed in between is not an owner.
  const grants: LakeGrant[] = (await db.dataLakeAccessGrants.listByLake(lake.id, { activeAsOf: now })).map(g => ({
    principalType: g.principalType,
    principalId: g.principalId,
    role: g.role,
  }));

  // Stale check. Compared as sets: `resolveEffectiveOwnerIds` order follows the grant read, which is
  // not a fact the offer should be sensitive to - only WHO owns the lake is.
  const currentOwners = resolveEffectiveOwnerIds(lake, grants).slice().sort();
  const snapshot = offer.priorOwnerUserIds.slice().sort();
  if (currentOwners.length !== snapshot.length || currentOwners.some((id, i) => id !== snapshot[i])) {
    throw new BadRequestError(
      'Ownership of this data lake changed after the offer was made, so it can no longer be accepted'
    );
  }

  // The lake's owning org is part of what the offer was made under. If the lake moved - to private, or
  // to a different org - since, the authorization premise is gone, and applying the snapshotted rung
  // would hand over a lake `resolveLakeTransferAuthority` would refuse at offer time today.
  const lakeOrg = normalizeId(lake.organizationId) ?? null;
  if (lakeOrg !== (offer.organizationId ?? null)) {
    throw new BadRequestError(
      'The data lake has moved to a different organization since this offer was made, so it can no longer be accepted'
    );
  }

  // The offerer's authority is re-checked, not assumed: a grant (or an offer) outlives the role that
  // motivated it, and the pending state opens a 7-day window the old synchronous transfer never had.
  if (offer.offeredVia === 'platform-admin') {
    // Authorized by the flag, not by membership, so the flag itself is what has to still hold.
    const offerer = await db.users.findById(offer.offeredByUserId);
    if (!offerer?.isAdmin) {
      throw new BadRequestError('The person who made this offer is no longer a platform admin');
    }
  }

  if (lakeOrg) {
    const org = await db.organizations.findById(lakeOrg);
    if (offer.offeredVia === 'org-admin') {
      // The org-admin rung is granted only through `administeredOrgIds` (billing owner, team manager,
      // appointed admin) - NOT roster membership, which `isOrgOwnershipCandidate` would also accept.
      // Re-checking the rung the offer actually used, or a demoted admin could still demote an owner.
      if (!org || !isOrgAdminOf(org, offer.offeredByUserId)) {
        throw new BadRequestError(
          'The person who made this offer is no longer an admin of the organization that owns this data lake'
        );
      }
    } else if (
      offer.offeredVia !== 'platform-admin' &&
      (!org || !isOrgOwnershipCandidate(org, offer.offeredByUserId))
    ) {
      // The ownership rungs (`creator`/`grant-owner`) still require the offerer to belong to the org:
      // an owner grant outlives membership, and the offerer may have left.
      throw new BadRequestError(
        'The person who made this offer is no longer a member of the organization that owns this data lake'
      );
    }
    if (!org || !isOrgOwnershipCandidate(org, recipientUserId)) {
      throw new BadRequestError('You are no longer a member of the organization that owns this data lake');
    }
  }

  const accepted = await db.ownershipOffers.resolve(offer.id, 'accepted');
  if (!accepted) {
    throw new BadRequestError(OFFER_CLOSED);
  }

  const applied = await applyLakeOwnershipTransfer(
    {
      userId: offer.offeredByUserId,
      isAdmin: offer.offeredVia === 'platform-admin',
      // Carries the OFFER-time principal snapshot, so the audit row names whoever made the offer
      // rather than the recipient who happened to accept it.
      ...(offer.auditPrincipal ? { auditPrincipal: offer.auditPrincipal } : {}),
    },
    lake,
    grants,
    recipientUserId,
    offer.offeredVia,
    { db, logger }
  );

  return { ...applied, offer: accepted };
}

/** Close an offer the recipient does not want. Touches no grants - there were none to touch. */
export async function declineLakeOwnershipOffer(
  recipientUserId: string,
  offerId: string,
  { db }: LakeOwnershipOfferAdapters
): Promise<IDataLakeOwnershipOfferDocument> {
  const offer = await db.ownershipOffers.findById(offerId);
  if (!offer || offer.recipientUserId !== recipientUserId) {
    throw new NotFoundError('Ownership offer not found');
  }
  const declined = await db.ownershipOffers.resolve(offer.id, 'declined');
  if (!declined) throw new BadRequestError(OFFER_CLOSED);
  return declined;
}

/**
 * Close a pending offer without transferring anything. Open to the offerer, and to anyone who
 * currently holds transfer authority over the lake (a platform admin, the effective owner, or an org
 * admin) - the same rule the offer was made under, so the door can never be narrower than the one
 * that opened it.
 */
export async function cancelLakeOwnershipOffer(
  actor: LakeTransferActor,
  lake: IDataLakeDocument,
  grants: LakeGrant[],
  { db }: LakeOwnershipOfferAdapters
): Promise<IDataLakeOwnershipOfferDocument> {
  // Any pending row, expired included: cancelling a lapsed offer is how a lake clears the slot for a
  // fresh one, and an expired offer is still a `pending` row until it is resolved.
  const pending = await db.ownershipOffers.findPendingForLake(lake.id);
  if (!pending) {
    throw new NotFoundError('This data lake has no pending ownership offer');
  }

  const isOfferer = !!actor.userId && actor.userId === pending.offeredByUserId;
  if (!isOfferer && !resolveLakeTransferAuthority(lake, actor, grants).allowed) {
    throw new BadRequestError('You do not have permission to cancel this ownership offer');
  }

  const cancelled = await db.ownershipOffers.resolve(pending.id, 'cancelled');
  if (!cancelled) throw new BadRequestError(OFFER_CLOSED);
  return cancelled;
}

/**
 * The live offer on a lake, for the transfer dialog, or null. Carries the recipient's display name
 * and the expiry - the offerer already knows the rest.
 */
export async function findPendingLakeOwnershipOffer(
  dataLakeId: string,
  { db }: LakeOwnershipOfferAdapters
): Promise<LakePendingOwnershipOffer | null> {
  const offer = await db.ownershipOffers.findPendingForLake(dataLakeId, new Date());
  if (!offer) return null;
  const recipient = await db.users.findById(offer.recipientUserId).catch(() => null);
  const recipientName = recipient?.name || recipient?.username;
  return {
    id: offer.id,
    offeredByUserId: offer.offeredByUserId,
    recipientUserId: offer.recipientUserId,
    ...(recipientName ? { recipientName } : {}),
    expiresAt: offer.expiresAt,
  };
}

/**
 * The recipient's own pending offers. Deliberately a narrow projection: the lake name, who offered
 * it, the expiry and the content gate - no files, no `systemPrompt`, no member roster. A recipient
 * may not be able to read the lake yet, and an offer must not become a back door onto its contents.
 */
export async function listLakeOwnershipOffersForRecipient(
  recipientUserId: string,
  { db }: LakeOwnershipOfferAdapters
): Promise<LakeOwnershipOfferSummary[]> {
  const offers = await db.ownershipOffers.listPendingForRecipient(recipientUserId, new Date());
  if (offers.length === 0) return [];

  const lakes = await Promise.all(offers.map(o => db.dataLakes.findById(o.dataLakeId).catch(() => null)));
  const offererIds = Array.from(new Set(offers.map(o => o.offeredByUserId)));
  const offerers = await db.users.findByIds(offererIds).catch(() => []);
  const offererNames = new Map(offerers.map(u => [u.id, u.name || u.username]));

  return offers.flatMap((offer, i) => {
    const lake = lakes[i];
    // A lake deleted while an offer is open is not an offer: nothing could be accepted onto it.
    if (!lake) return [];
    const gate =
      lake.requiredUserTag || lake.requiredEntitlement
        ? {
            ...(lake.requiredUserTag ? { requiredUserTag: lake.requiredUserTag } : {}),
            ...(lake.requiredEntitlement ? { requiredEntitlement: lake.requiredEntitlement } : {}),
          }
        : undefined;
    const offeredByName = offererNames.get(offer.offeredByUserId);
    return [
      {
        id: offer.id,
        dataLakeId: lake.id,
        lakeName: lake.name,
        ...(offeredByName ? { offeredByName } : {}),
        expiresAt: offer.expiresAt,
        ...(gate ? { gate } : {}),
      },
    ];
  });
}
