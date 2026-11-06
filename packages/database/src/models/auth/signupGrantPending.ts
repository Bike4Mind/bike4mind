import mongoose, { type PipelineStage } from 'mongoose';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { User } from './UserModel';

/** `locked`: credits remain but nothing pays them without an unlock or an admin (email unverified, forfeited). */
export type SignupGrantPendingStatus = 'held' | 'dripping' | 'locked' | 'blocked';
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

export type SignupGrantPendingQueue = { held: number; oldestHeldAt: Date | null };

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

const blockedMatch = { 'signupGrant.blocked': { $type: 'object' } };
const heldMatch = { signupGrantHeldReason: { $type: 'string' }, tags: PENDING_FREE_CREDITS_TAG };
const fromPackage = { grantPackageId: { $type: 'string', $ne: '' } };

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
      _forfeited: { $cond: [{ $ifNull: ['$signupGrant.unlockForfeited', false] }, true, false] },
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
      status: {
        $switch: {
          branches: [
            { case: '$_blocked', then: 'blocked' },
            { case: '$_held', then: 'held' },
            { case: { $and: ['$_hasGrant', '$_dripOpen'] }, then: 'dripping' },
          ],
          default: 'locked',
        },
      },
    },
  },
  { $match: { $or: [{ remaining: { $gt: 0 } }, { _held: true }, { _blocked: true }] } },
];

type ListPendingInput = {
  dripCap: number;
  status?: SignupGrantPendingStatus;
  heldReason?: SignupGrantPendingHeldReason;
  source?: 'default' | 'package';
  sort: SignupGrantPendingSort;
  cursor?: SignupGrantPendingCursor;
  limit: number;
};

const STATUS_PREMATCH: Record<SignupGrantPendingStatus, Record<string, unknown>> = {
  blocked: blockedMatch,
  held: { ...heldMatch, 'signupGrant.blocked': { $not: { $type: 'object' } } },
  dripping: { 'signupGrant.stage': { $type: 'string' }, $nor: [blockedMatch, heldMatch] },
  locked: { $nor: [blockedMatch, heldMatch] },
};

/**
 * Every filter on a stored field runs in the first $match, beside the index-backed candidate $or. The rest
 * (remaining > 0, the dripping/locked split, the remaining cursor) depends on the live dripCap, so each page
 * still sorts the pre-matched set in memory, bounded by maxTimeMS. A pre-$addFields _id sort is avoided on
 * purpose: it could let the planner prefer a whole-collection _id index scan to the partial indexes.
 */
export const buildListPendingPipeline = (input: ListPendingInput): PipelineStage[] => {
  const pre: Record<string, unknown>[] = [candidateMatch];
  const post: Record<string, unknown>[] = [];
  if (input.status) {
    pre.push(STATUS_PREMATCH[input.status]);
    post.push({ status: input.status });
  }
  if (input.heldReason) pre.push({ signupGrantHeldReason: input.heldReason, tags: PENDING_FREE_CREDITS_TAG });
  if (input.source === 'package') pre.push({ 'signupGrant.stage': { $type: 'string' }, ...fromPackage });
  if (input.source === 'default') pre.push({ 'signupGrant.stage': { $type: 'string' }, $nor: [fromPackage] });

  const cursor = input.cursor;
  const cursorId = cursor ? new mongoose.Types.ObjectId(cursor.id) : null;
  if (input.sort === 'oldest' && cursorId) pre.push({ _id: { $gt: cursorId } });
  if (input.sort === 'remaining' && cursor && cursorId) {
    const r = cursor.remaining ?? 0;
    post.push({ $or: [{ remaining: { $lt: r } }, { remaining: r, _id: { $gt: cursorId } }] });
  }

  return [
    { $match: { $and: pre } },
    ...derivedFields(input.dripCap),
    ...(post.length ? [{ $match: { $and: post } }] : []),
    { $sort: input.sort === 'remaining' ? { remaining: -1 as const, _id: 1 as const } : { _id: 1 as const } },
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
};

export const signupGrantPendingRepository = {
  /** One page plus one extra row, so the caller can tell whether a next page exists. */
  async listPending(
    input: ListPendingInput
  ): Promise<{ rows: SignupGrantPendingRow[]; next: SignupGrantPendingCursor | null }> {
    const docs = await User.aggregate(buildListPendingPipeline(input)).option({ maxTimeMS: QUERY_MAX_TIME_MS });
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

  /**
   * Exposure the grant flow can still pay, over the population listPending pages through. Blocked and
   * forfeited grants pay nothing without an admin, so they are listed but left out of these totals.
   */
  async summarizePending(input: { dripCap: number }): Promise<SignupGrantPendingSummary> {
    const payable = { $not: [{ $or: ['$_blocked', '$_forfeited'] }] };
    const [totals] = await User.aggregate<SignupGrantPendingSummary>([
      { $match: candidateMatch },
      ...derivedFields(input.dripCap),
      {
        $group: {
          _id: null,
          accountsWithRemaining: { $sum: { $cond: [{ $and: [payable, { $gt: ['$remaining', 0] }] }, 1, 0] } },
          totalRemaining: { $sum: { $cond: [payable, '$remaining', 0] } },
          totalDripRemaining: { $sum: { $cond: [payable, '$dripRemaining', 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS });
    return totals ?? { accountsWithRemaining: 0, totalRemaining: 0, totalDripRemaining: 0 };
  },

  /** Count and oldest hold time of the accounts listPending labels `held` (either reason, not blocked). */
  async heldQueue(): Promise<SignupGrantPendingQueue> {
    const filter = STATUS_PREMATCH.held;
    const [held, oldest] = await Promise.all([
      User.countDocuments(filter),
      User.findOne({ ...filter, signupGrantHeldAt: { $type: 'date' } })
        .sort({ signupGrantHeldAt: 1 })
        .select('signupGrantHeldAt')
        .lean(),
    ]);
    return { held, oldestHeldAt: oldest?.signupGrantHeldAt ?? null };
  },
};
