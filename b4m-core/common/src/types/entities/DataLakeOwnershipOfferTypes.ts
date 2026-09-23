import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS, type LakeManageRung } from './LakeConfigChangeEventTypes';

// -- Data Lake Ownership Offer ---------------------------------------------------------------
//
// Ownership of a lake moves through an `owner` grant, and until this relation existed that grant
// was PUSHED onto the recipient by whoever held transfer authority - the recipient had no say and
// was not told. An owner grant also carries the lake's `systemPrompt` into the holder's turns
// (#2495), so an unasked-for grant is an injection channel, not just a surprising role change.
//
// This is the pending-offer record that stands between the two: `offerLakeOwnership` writes one of
// these (no grant changes), and `acceptLakeOwnershipOffer` applies the transfer only when the
// recipient says yes. Types live here rather than inline in the model because the services that
// drive it live in b4m-core/services, which cannot import @bike4mind/database - the same split
// DataLakeAccessGrantModel and DataLakeSpendNotificationModel use.

export const DATA_LAKE_OWNERSHIP_OFFER_STATUSES = ['pending', 'accepted', 'declined', 'cancelled'] as const;
export type DataLakeOwnershipOfferStatus = (typeof DATA_LAKE_OWNERSHIP_OFFER_STATUSES)[number];

/**
 * The rung that authorized the ORIGINAL offer, snapshotted so the accept can attribute the applied
 * transfer to the same authority that decided it. Narrower than `LakeManageRung` on purpose: the
 * transfer gate admits exactly these four, so `grant-curator`/`org-grant`/`system` can never be an
 * offer's origin and storing them would only invite a reader to believe otherwise.
 */
export const DATA_LAKE_OWNERSHIP_OFFER_RUNGS = ['grant-owner', 'creator', 'platform-admin', 'org-admin'] as const;
export type DataLakeOwnershipOfferRung = Extract<LakeManageRung, (typeof DATA_LAKE_OWNERSHIP_OFFER_RUNGS)[number]>;

/** How long a recipient has to accept. A single constant so the window has one home. */
export const DATA_LAKE_OWNERSHIP_OFFER_TTL_DAYS = 7;

export const DataLakeOwnershipOffer = z.object({
  dataLakeId: z.string(),
  /** Denormalized from the lake at offer time: a recipient route can filter by it without a join. */
  organizationId: z.string().nullish(),
  /** The actor who made the offer - always the eventual `grantedByUserId` of an accepted transfer. */
  offeredByUserId: z.string(),
  recipientUserId: z.string(),
  status: z.enum(DATA_LAKE_OWNERSHIP_OFFER_STATUSES),
  expiresAt: z.date(),
  /** Set by the atomic `resolve` when the offer leaves `pending`; null while it is still open. */
  resolvedAt: z.date().nullish(),
  /**
   * The lake's effective owner ids AT OFFER TIME. Accept re-resolves them and refuses if they moved,
   * so an offer can never apply a transfer over another transfer (or a departure succession) that
   * happened in between. Snapshotted rather than recomputed because "stale" is exactly the case
   * where today's answer differs from the one the offer was made under.
   */
  priorOwnerUserIds: z.array(z.string()),
  offeredVia: z.enum(DATA_LAKE_OWNERSHIP_OFFER_RUNGS),
  /**
   * The principal to attribute the applied transfer to, resolved by the route at OFFER time (only a
   * route can tell an API key from a session). Carried so the eventual audit row keeps naming the
   * same principal the offer was made under, rather than whichever principal happens to accept.
   */
  auditPrincipal: z
    .object({
      principalKind: z.enum(LAKE_CONFIG_CHANGE_PRINCIPAL_KINDS),
      principalId: z.string(),
      onBehalfOfUserId: z.string().optional(),
    })
    .optional(),
});

export type IDataLakeOwnershipOffer = z.infer<typeof DataLakeOwnershipOffer>;

export interface IDataLakeOwnershipOfferDocument extends IDataLakeOwnershipOffer, IMongoDocument {}

export interface IDataLakeOwnershipOfferRepository extends IBaseRepository<IDataLakeOwnershipOfferDocument> {
  /**
   * The live (pending, unexpired as of `asOf`) offer for a lake, or null. At most one exists - the
   * model's partial unique index makes a second concurrent offer fail rather than queue.
   */
  findPendingForLake(dataLakeId: string, asOf?: Date): Promise<IDataLakeOwnershipOfferDocument | null>;
  /** Every live offer addressed to a recipient, newest first - the recipient's pending-offer list. */
  listPendingForRecipient(recipientUserId: string, asOf?: Date): Promise<IDataLakeOwnershipOfferDocument[]>;
  /**
   * Atomically move an offer out of `fromStatus` (default `pending`) into `toStatus`, stamping
   * `resolvedAt`. Returns the updated row, or null when the offer was already resolved - the "did I
   * win the race" signal that makes a double accept refuse rather than run the transfer twice. The
   * status precondition is the whole mechanism: never read-then-write.
   */
  resolve(
    id: string,
    toStatus: DataLakeOwnershipOfferStatus,
    fromStatus?: DataLakeOwnershipOfferStatus
  ): Promise<IDataLakeOwnershipOfferDocument | null>;
}

/**
 * The live-offer state of one lake, as disclosed to the transfer dialog. Deliberately carries no
 * `systemPrompt`, no files and no membership - only what the offerer already knows they did, plus
 * the recipient's display name so the dialog can say who it is waiting on.
 */
export interface LakePendingOwnershipOffer {
  id: string;
  recipientUserId: string;
  recipientName?: string;
  expiresAt: Date;
}

/**
 * One offer as the RECIPIENT sees it. The disclosure is deliberately narrow (lake name, offerer
 * display name, the content-gate note and the expiry): the recipient may not be able to read the
 * lake yet, and an offer must not become a back door onto its contents or its member roster.
 */
export interface LakeOwnershipOfferSummary {
  id: string;
  dataLakeId: string;
  lakeName: string;
  offeredByName?: string;
  expiresAt: Date;
  /** The lake's content gate, so an accept knows what it is agreeing to bypass (see LakeOwnershipCandidateList.gate). */
  gate?: {
    requiredUserTag?: string;
    requiredEntitlement?: string;
  };
}
