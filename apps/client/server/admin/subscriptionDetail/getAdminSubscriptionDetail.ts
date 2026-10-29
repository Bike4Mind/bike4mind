import { Organization, User, creditTransactionRepository, mongoose } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import type {
  AdminSubscriptionCreditGrant,
  AdminSubscriptionDetail,
  AdminSubscriptionSeats,
} from '@client/app/utils/adminSubscriptionDetail';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { Subscription } from '@server/models/Subscription';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '../subscriptionsList/listAdminSubscriptions';
import { subscriptionPlanCatalog } from '../subscriptionsList/adminSubscriptionsQuery';

const RECENT_GRANT_LIMIT = 6;
const OTHER_SUBSCRIPTIONS_LIMIT = 10;
const READ_MAX_TIME_MS = 10_000;

type DetailDoc = SubscriptionDoc & { grantedBy?: string | null; grantedReason?: string | null };

type OwnerRecord = {
  userId?: string | null;
  seats?: number | null;
  currentCredits?: number | null;
  users?: unknown[] | null;
};

const defaultCreditsPerCycle = async (doc: DetailDoc): Promise<number | null> => {
  if (doc.ownerType === 'User') return SUBSCRIPTION_PLANS_MAP[doc.priceId ?? '']?.credits ?? null;
  return doc.quantity * (await getTeamPlanSettings()).creditsPerSeat;
};

const recentGrantsOf = async (doc: DetailDoc): Promise<AdminSubscriptionCreditGrant[]> => {
  const holderType = doc.ownerType === 'User' ? CreditHolderType.User : CreditHolderType.Organization;
  const transactions = await creditTransactionRepository.findByOwnerWithFilters(doc.ownerId, holderType, {
    transactionTypes: ['subscription'],
    limit: RECENT_GRANT_LIMIT,
  });
  return transactions.map(transaction => ({
    id: String(transaction.id),
    credits: transaction.credits,
    createdAt: new Date(transaction.createdAt).toISOString(),
  }));
};

const seatsOf = async (doc: DetailDoc, organization: OwnerRecord | null): Promise<AdminSubscriptionSeats> => {
  const { minSeats, maxSeats } = await getTeamPlanSettings();
  return {
    paid: doc.quantity,
    organizationSeats: organization?.seats ?? null,
    members: (organization?.users?.length ?? 0) + 1,
    min: minSeats,
    max: maxSeats,
  };
};

const findOwner = async (doc: DetailDoc): Promise<OwnerRecord | null> => {
  if (!mongoose.Types.ObjectId.isValid(doc.ownerId)) return null;
  const fields = 'currentCredits seats userId users.userId';
  return doc.ownerType === 'User'
    ? User.findById(doc.ownerId).select(fields).lean<OwnerRecord>()
    : Organization.findById(doc.ownerId).select(fields).lean<OwnerRecord>();
};

/** The detail page's payload, or null for an id that is not an ObjectId or names no subscription. */
export async function getAdminSubscriptionDetail(id: string): Promise<AdminSubscriptionDetail | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await Subscription.findById(id).maxTimeMS(READ_MAX_TIME_MS).lean<DetailDoc>();
  if (!doc) return null;

  const isUserOwned = doc.ownerType === 'User';
  const [owner, others, defaultPerCycle, recentGrants] = await Promise.all([
    findOwner(doc),
    Subscription.find({ ownerType: doc.ownerType, ownerId: doc.ownerId, _id: { $ne: doc._id } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(OTHER_SUBSCRIPTIONS_LIMIT)
      .maxTimeMS(READ_MAX_TIME_MS)
      .lean<SubscriptionDoc[]>(),
    defaultCreditsPerCycle(doc),
    recentGrantsOf(doc),
  ]);

  const catalog = subscriptionPlanCatalog();
  const [[subscription], otherSubscriptions] = await Promise.all([
    toAdminSubscriptionRows([doc], catalog),
    toAdminSubscriptionRows(others, catalog),
  ]);
  const customPerCycle = doc.customCreditsPerCycle ?? null;

  return {
    subscription,
    grantedBy: doc.grantedBy ?? null,
    grantedReason: doc.grantedReason ?? null,
    credits: {
      defaultPerCycle,
      customPerCycle,
      effectivePerCycle: customPerCycle ?? defaultPerCycle,
      recentGrants,
    },
    ownerCredits: owner ? (owner.currentCredits ?? 0) : null,
    otherSubscriptions,
    seats: isUserOwned ? null : await seatsOf(doc, owner),
    actingUserId: isUserOwned ? doc.ownerId : (owner?.userId ?? null),
  };
}
