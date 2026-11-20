import mongoose from 'mongoose';
import { canonicalizeEmail } from '@bike4mind/common';
import { CreditTransaction, safeDropIndex, User } from '@bike4mind/database';
import { type MigrationFile } from './index';

// Every runtime free grant keys on one of these (see grantFreeCredits in userService/freeCredits.ts).
// One anchored literal prefix per query, so each scan stays bounded on the transactionId index.
const FREE_GRANT_TRANSACTION_ID_PREFIXES = [/^verify-grant:/, /^otc-register-grant:/];
const CLAIM_INDEX_NAME = 'freeCreditClaimEmail_1';
const BATCH_SIZE = 1000;
const MAX_CLUSTERS_LOGGED = 50;

export type ClaimCandidate = {
  userId: string;
  email: string | null;
  /** freeCreditClaimEmail already on the account (a claim made at runtime since deploy). */
  existingClaim: string | null;
  /** When the account's first free grant committed; null for a claim with no grant yet. */
  grantedAt: Date | null;
};

export type ClaimCluster = { claimEmail: string; holderId: string; otherIds: string[] };

export type ClaimPlan = {
  set: Array<{ userId: string; claimEmail: string }>;
  /** Duplicate runtime claims (only possible before the unique index exists); the earliest wins. */
  unset: string[];
  /** Inboxes more than one account claimed or was granted under. */
  clusters: ClaimCluster[];
};

const byGrantedAt = (a: ClaimCandidate, b: ClaimCandidate) =>
  (a.grantedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.grantedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);

/**
 * Decide which account holds each inbox's claim. Existing runtime claims are authoritative; an
 * unclaimed account that already received a grant then claims its inbox if it is still free,
 * earliest grant first. Every other account on a claimed inbox is reported in its cluster.
 */
export function planFreeCreditClaims(candidates: ClaimCandidate[]): ClaimPlan {
  const holders = new Map<string, string>();
  const others = new Map<string, string[]>();
  const plan: ClaimPlan = { set: [], unset: [], clusters: [] };
  const addOther = (claimEmail: string, userId: string) =>
    others.set(claimEmail, [...(others.get(claimEmail) ?? []), userId]);

  const claimed = candidates.filter(c => c.existingClaim).sort(byGrantedAt);
  for (const { userId, existingClaim } of claimed) {
    const claimEmail = existingClaim as string;
    if (holders.has(claimEmail)) {
      plan.unset.push(userId);
      addOther(claimEmail, userId);
    } else {
      holders.set(claimEmail, userId);
    }
  }

  const unclaimed = candidates.filter(c => !c.existingClaim && c.grantedAt).sort(byGrantedAt);
  for (const { userId, email } of unclaimed) {
    const claimEmail = email ? canonicalizeEmail(email) : null;
    if (!claimEmail) continue;
    if (holders.has(claimEmail)) {
      addOther(claimEmail, userId);
    } else {
      holders.set(claimEmail, userId);
      plan.set.push({ userId, claimEmail });
    }
  }

  plan.clusters = [...others].map(([claimEmail, otherIds]) => ({
    claimEmail,
    holderId: holders.get(claimEmail) as string,
    otherIds,
  }));
  return plan;
}

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function loadEarliestGrants(): Promise<Map<string, Date>> {
  const earliest = new Map<string, Date>();
  for (const prefix of FREE_GRANT_TRANSACTION_ID_PREFIXES) {
    const cursor = CreditTransaction.collection.find(
      { transactionId: { $regex: prefix }, ownerType: 'User' },
      { projection: { ownerId: 1, createdAt: 1 } }
    );
    for await (const grant of cursor) {
      const ownerId = String(grant.ownerId);
      const grantedAt: Date = grant.createdAt ?? new Date(0);
      const known = earliest.get(ownerId);
      if (!known || grantedAt < known) earliest.set(ownerId, grantedAt);
    }
  }
  return earliest;
}

type UserRow = { _id: mongoose.Types.ObjectId; email?: string | null; freeCreditClaimEmail?: string | null };

async function loadCandidates(earliestGrants: Map<string, Date>): Promise<ClaimCandidate[]> {
  const toCandidate = (user: UserRow): ClaimCandidate => ({
    userId: String(user._id),
    email: user.email ?? null,
    existingClaim: user.freeCreditClaimEmail ?? null,
    grantedAt: earliestGrants.get(String(user._id)) ?? null,
  });
  const projection = { email: 1, freeCreditClaimEmail: 1 };
  const users = User.db.collection<UserRow>(User.collection.collectionName);

  const byId = new Map<string, ClaimCandidate>();
  const grantedIds = [...earliestGrants.keys()].filter(id => mongoose.Types.ObjectId.isValid(id));
  for (const ids of chunk(grantedIds, BATCH_SIZE)) {
    const rows = await users
      .find({ _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } }, { projection })
      .toArray();
    for (const row of rows) byId.set(String(row._id), toCandidate(row));
  }
  for await (const row of users.find({ freeCreditClaimEmail: { $type: 'string' } }, { projection })) {
    byId.set(String(row._id), toCandidate(row));
  }
  return [...byId.values()];
}

async function applyPlan(plan: ClaimPlan): Promise<void> {
  const users = User.collection;
  for (const ids of chunk(plan.unset, BATCH_SIZE)) {
    await users.updateMany(
      { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } },
      { $unset: { freeCreditClaimEmail: '' } }
    );
  }
  for (const batch of chunk(plan.set, BATCH_SIZE)) {
    await users.bulkWrite(
      batch.map(({ userId, claimEmail }) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(userId), freeCreditClaimEmail: null },
          update: { $set: { freeCreditClaimEmail: claimEmail } },
        },
      })),
      { ordered: false }
    );
  }
}

function logClusters(clusters: ClaimCluster[]): void {
  const extraAccounts = clusters.reduce((sum, cluster) => sum + cluster.otherIds.length, 0);
  console.log(
    `  ${clusters.length} inbox(es) shared by more than one granted account (${extraAccounts} extra accounts)`
  );
  const largest = [...clusters].sort((a, b) => b.otherIds.length - a.otherIds.length).slice(0, MAX_CLUSTERS_LOGGED);
  // User ids only: the inbox itself stays out of the migration log.
  for (const { holderId, otherIds } of largest) {
    console.log(`  holder ${holderId}: ${otherIds.length} more -> ${otherIds.join(', ')}`);
  }
}

/**
 * Backfill users.freeCreditClaimEmail (one free-credit grant per inbox, see
 * UserRepository.claimFreeCreditGrant) for accounts that already received a grant, then build the
 * unique index that makes runtime claims atomic. The earliest-granted account on each inbox holds
 * its claim; the other accounts keep the credits they already have and are logged by user id so
 * clustered signups can be reviewed. Runs on the raw collections so accounts flagged deletedAt count.
 *
 * Invite-resolved grants share the verify-grant: id, so a pre-deploy invitee is backfilled as its
 * inbox's holder even though a runtime invite grant no longer claims (see grantFreeCredits). The
 * ledger cannot tell the two apart; the cost is that aliases of those invitees get no default grant.
 *
 * Idempotent. Deployed environments migrate before the new code serves, so no runtime claim races
 * the backfill; if one does (code deployed first), the index build fails on the duplicate and a
 * re-run clears it. Id backdated below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001),
 * which must stay last.
 */
const migration: MigrationFile = {
  id: 20260921235965,
  name: 'backfill free credit claim email',

  up: async () => {
    const earliestGrants = await loadEarliestGrants();
    const plan = planFreeCreditClaims(await loadCandidates(earliestGrants));
    await applyPlan(plan);
    await User.collection.createIndex(
      { freeCreditClaimEmail: 1 },
      { unique: true, partialFilterExpression: { freeCreditClaimEmail: { $type: 'string' } }, name: CLAIM_INDEX_NAME }
    );
    console.log(
      `Claimed ${plan.set.length} inbox(es) for granted accounts, cleared ${plan.unset.length} duplicate claim(s)`
    );
    logClusters(plan.clusters);
  },

  down: async () => {
    // The field is inert without the index, so only the index is dropped.
    await safeDropIndex(User.collection, CLAIM_INDEX_NAME);
  },
};

export default migration;
