import mongoose, { type PipelineStage } from 'mongoose';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { User } from './UserModel';
import type { HeldSignupGrantReason } from './SignupGrantReleaseBatchModel';

export type SignupGrantPendingStatus = 'held' | 'dripping' | 'blocked';
export type SignupGrantPendingHeldReason = 'budget_exhausted' | 'risk_review';
export type SignupGrantPendingSort = 'oldest' | 'remaining';

export type SignupGrantPendingCursor = { id: string; remaining?: number };

export type SignupGrantPendingRow = {
  id: string;
  email: string | null;
  createdAt: Date | null;
  source: 'default' | 'package' | null;
  stage: 'pending_email' | 'signup' | 'unlocked' | null;
  status: SignupGrantPendingStatus;
  heldReason: SignupGrantPendingHeldReason | null;
  heldAt: Date | null;
  heldCredits: number;
  blockedAt: Date | null;
  remaining: number;
  dripRemaining: number;
};

export type SignupGrantPendingSummary = {
  accountsWithRemaining: number;
  totalRemaining: number;
  totalDripRemaining: number;
};

const QUERY_MAX_TIME_MS = 10_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Accounts with signup-grant credits still to come, a held tranche, or a block. Each $or branch repeats its
 * partial-index $type (user_signupGrant_stage, user_signupGrantHeldReason) so the planner can use both indexes.
 */
const candidateMatch = {
  $or: [
    { 'signupGrant.stage': { $type: 'string' } },
    { signupGrantHeldReason: { $type: 'string' }, tags: PENDING_FREE_CREDITS_TAG },
  ],
};

const num = (path: string) => ({ $ifNull: [path, 0] });

/**
 * Mirrors signupGrantRemaining, signupGrantDripOpen and signupGrantDripRemaining in @bike4mind/common
 * (signupGrant.ts); signupGrantPending.test.ts asserts the two agree row by row.
 */
const derivedFields = (dripCap: number): PipelineStage[] => [
  {
    $addFields: {
      _hasGrant: { $eq: [{ $type: '$signupGrant.stage' }, 'string'] },
      _dripOpen: {
        $and: [
          { $not: [{ $ifNull: ['$signupGrant.unlockForfeited', false] }] },
          {
            $or: [
              { $eq: ['$signupGrant.stage', 'signup'] },
              {
                $and: [
                  { $eq: ['$signupGrant.stage', 'unlocked'] },
                  { $eq: ['$signupGrant.unlockedBy', 'activity_drip'] },
                ],
              },
            ],
          },
        ],
      },
      _dripped: {
        $cond: [
          {
            $and: [
              { $isNumber: '$signupGrant.dripCredits' },
              { $eq: [{ $trunc: '$signupGrant.dripCredits' }, '$signupGrant.dripCredits'] },
              { $gt: ['$signupGrant.dripCredits', 0] },
              { $lte: ['$signupGrant.dripCredits', MAX_SAFE] },
            ],
          },
          '$signupGrant.dripCredits',
          0,
        ],
      },
      _held: {
        $and: [
          { $eq: [{ $type: '$signupGrantHeldReason' }, 'string'] },
          { $in: [PENDING_FREE_CREDITS_TAG, { $ifNull: ['$tags', []] }] },
        ],
      },
      _blocked: { $eq: [{ $type: '$signupGrant.blocked' }, 'object'] },
    },
  },
  {
    $addFields: {
      remaining: {
        $cond: [
          '$_hasGrant',
          {
            $max: [
              0,
              {
                $subtract: [
                  {
                    $add: [
                      num('$signupGrant.signupCredits'),
                      {
                        $cond: [
                          '$_dripOpen',
                          { $max: [num('$signupGrant.unlockCredits'), dripCap] },
                          num('$signupGrant.unlockCredits'),
                        ],
                      },
                    ],
                  },
                  num('$signupGrant.creditsReleased'),
                ],
              },
            ],
          },
          0,
        ],
      },
      dripRemaining: {
        $cond: [{ $and: ['$_hasGrant', '$_dripOpen'] }, { $max: [0, { $subtract: [dripCap, '$_dripped'] }] }, 0],
      },
      status: { $cond: ['$_blocked', 'blocked', { $cond: ['$_held', 'held', 'dripping'] }] },
    },
  },
  { $match: { $or: [{ remaining: { $gt: 0 } }, { _held: true }, { _blocked: true }] } },
];

export const signupGrantPendingRepository = {
  /** One page plus one extra row, so the caller can tell whether a next page exists. */
  async listPending(input: {
    dripCap: number;
    status?: SignupGrantPendingStatus;
    heldReason?: SignupGrantPendingHeldReason;
    source?: 'default' | 'package';
    sort: SignupGrantPendingSort;
    cursor?: SignupGrantPendingCursor;
    limit: number;
  }): Promise<{ rows: SignupGrantPendingRow[]; next: SignupGrantPendingCursor | null }> {
    const filters: Record<string, unknown>[] = [];
    if (input.status) filters.push({ status: input.status });
    if (input.heldReason) filters.push({ _held: true, signupGrantHeldReason: input.heldReason });
    const fromPackage = { grantPackageId: { $type: 'string', $ne: '' } };
    if (input.source === 'package') filters.push({ _hasGrant: true, ...fromPackage });
    if (input.source === 'default') filters.push({ _hasGrant: true, $nor: [fromPackage] });

    const cursor = input.cursor;
    if (cursor) {
      const id = new mongoose.Types.ObjectId(cursor.id);
      if (input.sort === 'remaining') {
        const r = cursor.remaining ?? 0;
        filters.push({ $or: [{ remaining: { $lt: r } }, { remaining: r, _id: { $gt: id } }] });
      } else {
        filters.push({ _id: { $gt: id } });
      }
    }

    const pipeline: PipelineStage[] = [
      { $match: candidateMatch },
      ...derivedFields(input.dripCap),
      ...(filters.length ? [{ $match: { $and: filters } }] : []),
      { $sort: input.sort === 'remaining' ? { remaining: -1, _id: 1 } : { _id: 1 } },
      { $limit: input.limit + 1 },
      {
        $project: {
          email: 1,
          createdAt: 1,
          grantPackageId: 1,
          stage: '$signupGrant.stage',
          status: 1,
          signupGrantHeldReason: 1,
          signupGrantHeldAt: 1,
          pendingCreditGrant: 1,
          blockedAt: '$signupGrant.blocked.at',
          remaining: 1,
          dripRemaining: 1,
          _held: 1,
          _hasGrant: 1,
        },
      },
    ];

    const docs = await User.aggregate(pipeline).option({ maxTimeMS: QUERY_MAX_TIME_MS });
    const page = docs.slice(0, input.limit);
    const rows = page.map((doc): SignupGrantPendingRow => ({
      id: String(doc._id),
      email: doc.email ?? null,
      createdAt: doc.createdAt ?? null,
      source: doc._hasGrant ? (doc.grantPackageId ? 'package' : 'default') : null,
      stage: doc.stage ?? null,
      status: doc.status,
      heldReason: doc._held ? doc.signupGrantHeldReason : null,
      heldAt: doc._held ? (doc.signupGrantHeldAt ?? null) : null,
      heldCredits: doc._held ? (doc.pendingCreditGrant ?? 0) : 0,
      blockedAt: doc.blockedAt ?? null,
      remaining: doc.remaining,
      dripRemaining: doc.dripRemaining,
    }));
    const last = rows[rows.length - 1];
    const next =
      docs.length > input.limit && last
        ? input.sort === 'remaining'
          ? { id: last.id, remaining: last.remaining }
          : { id: last.id }
        : null;
    return { rows, next };
  },

  /** Exposure totals over the same population listPending pages through, unfiltered. */
  async summarizePending(input: { dripCap: number }): Promise<SignupGrantPendingSummary> {
    const [totals] = await User.aggregate<SignupGrantPendingSummary>([
      { $match: candidateMatch },
      ...derivedFields(input.dripCap),
      {
        $group: {
          _id: null,
          accountsWithRemaining: { $sum: { $cond: [{ $gt: ['$remaining', 0] }, 1, 0] } },
          totalRemaining: { $sum: '$remaining' },
          totalDripRemaining: { $sum: '$dripRemaining' },
        },
      },
      { $project: { _id: 0 } },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS });
    return totals ?? { accountsWithRemaining: 0, totalRemaining: 0, totalDripRemaining: 0 };
  },

  /** Oldest held tranche's hold time among accounts countHeld counts, or null when none is held. */
  async oldestHeldAt(reason: HeldSignupGrantReason = 'budget_exhausted'): Promise<Date | null> {
    const [doc] = await User.find({
      signupGrantHeldReason: { $eq: reason, $type: 'string' },
      tags: PENDING_FREE_CREDITS_TAG,
      signupGrantHeldAt: { $type: 'date' },
    })
      .sort({ signupGrantHeldAt: 1 })
      .limit(1)
      .select('signupGrantHeldAt')
      .lean();
    return doc?.signupGrantHeldAt ?? null;
  },
};
