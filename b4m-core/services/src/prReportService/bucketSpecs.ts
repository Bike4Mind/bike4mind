/**
 * PR report generator - lumina5's bucket taxonomy.
 *
 * Derived from the labels actually in use on Bike4Mind/bike4mind, not copied from
 * the blueprint's example set. Every structural BucketRole that participates in an
 * ordering rule is represented, and `none` is the mandatory catch-all.
 *
 * `order` drives BOTH precedence (which guard is checked first) and render order
 * (which section prints first), per the blueprint's BucketSpec contract. The
 * ordering constraints it has to satisfy:
 *   - shortCircuit first, so release/draft PRs never leak into a workflow section
 *   - testing before every approval-sensitive state, so approval cannot pull a PR
 *     out of QA (review approval is not QA sign-off)
 *   - reviewGate before approvedGeneric, so a PR carrying both lands in the more
 *     actionable one
 *   - the title fallbacks (dependencies, inProgress) after all label matching, so
 *     a labelled PR keeps its labelled bucket
 *   - catchAll last
 */

import type { Bucket, BucketSpecs } from './types';

/**
 * Label sets per bucket, matched case-insensitively. A label that carries no
 * workflow meaning is deliberately absent - `preview-deployed` is a deployment
 * fact and `bot-review` a review-source fact, so neither should decide a bucket.
 */
export const BUCKET_LABELS: Partial<Record<Bucket, readonly string[]>> = {
  release: ['autorelease: pending', 'autorelease: tagged'],
  qaInProgress: ['qa: in_progress'],
  awaitingTesting: ['awaiting testing'],
  qaClarification: ['qa_clarification'],
  qaFailed: ['qa_failed'],
  mergeConflict: ['merge conflict', 'merge queue issue'],
  awaitingFix: ['awaiting fix'],
  onHold: ['backlog', 'needs-discussion', 'wontfix'],
  changeRequest: ['change request', 'awaiting changes'],
  awaitingSpecialReview: ['devops'],
  awaitingReview: ['awaiting review'],
  reviewOngoing: ['review_ongoing'],
  readyForMerge: ['ready 2 ship', 'qa_passed', 'qa_testing_done'],
  approved: ['done reviewing'],
  dependencies: ['dependencies'],
} as const;

/** Priority labels, most urgent first. `null` (no label) always sorts last. */
export const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3'] as const;

/**
 * Title-based fallbacks, matched only AFTER every label check. An unlabelled
 * dependency bump is still categorized instead of dropping to the catch-all, but a
 * labelled one keeps its label.
 */
export const DEPENDENCY_TITLE_PATTERN = /^(?:chore|build|fix|deps)\s*\(deps(?:-dev)?\)|^bump\s|^deps:/i;
export const WIP_TITLE_PATTERN = /^\s*(?:\[wip\]|wip\b|\(wip\))/i;

export const BUCKET_SPECS: BucketSpecs = {
  // ── Short-circuits: outside the review/QA flow entirely ───────────────────
  release: {
    role: 'shortCircuit',
    title: 'Release',
    order: 10,
    mention: 'owner',
    subGroupByPriority: false,
  },
  draft: {
    role: 'shortCircuit',
    title: 'Drafts',
    order: 20,
    mention: 'owner',
    subGroupByPriority: false,
  },

  // ── Testing: checked BEFORE approval so approval can't pull a PR out of QA ─
  //
  // All three use `mention: 'owner'`, NOT a QA role roster. The blueprint warns
  // that an `assignee`-gated roster is only as good as the convention behind it,
  // and on this repo the convention does not hold: 35 of 36 open PRs have the
  // author as first assignee, including every QA-labelled one. A roster gate here
  // would be permanently stuck shut - the QA pool never tagged, every line
  // pinging the developer, inside sections whose whole purpose is nudging QA.
  // Wire these to `roleRoster` + `specificOwner: 'assignee'` only once PRs are
  // reassigned as work transfers from developer to QA.
  qaInProgress: {
    role: 'testing',
    title: 'In QA',
    order: 30,
    mention: 'owner',
    subGroupByPriority: true,
  },
  awaitingTesting: {
    role: 'testing',
    title: 'Awaiting QA',
    order: 40,
    mention: 'owner',
    subGroupByPriority: true,
  },
  qaClarification: {
    role: 'testing',
    title: 'QA - awaiting clarification',
    order: 50,
    mention: 'owner',
    subGroupByPriority: false,
  },

  // ── Standalone states, matched on their own ───────────────────────────────
  //
  // qaFailed and awaitingFix are NOT review gates: the author is applying agreed
  // changes, so an approving review does not re-route them (contrast
  // changeRequest, where the gate label really is stale once approved).
  qaFailed: {
    role: 'standalone',
    title: 'QA failed - back on the author',
    order: 60,
    mention: 'owner',
    subGroupByPriority: true,
  },
  // Ordered ahead of readyForMerge on purpose: a PR carrying both `qa_passed` and
  // `merge conflict` is not ready to merge, it is blocked on the author.
  mergeConflict: {
    role: 'standalone',
    title: 'Blocked - merge conflict',
    order: 70,
    mention: 'owner',
    subGroupByPriority: true,
  },
  awaitingFix: {
    role: 'standalone',
    title: 'Author applying changes',
    order: 80,
    mention: 'owner',
    subGroupByPriority: true,
  },
  onHold: {
    role: 'standalone',
    title: 'On hold',
    order: 90,
    mention: 'owner',
    subGroupByPriority: false,
  },

  // ── The approval re-route destination ─────────────────────────────────────
  //
  // Never matched by a guard - review-gate buckets re-route INTO it when the PR is
  // approved, because the gate label is stale and the ball is in the author's
  // court. Its order therefore only affects rendering.
  approvedAwaitingAuthor: {
    role: 'approvedReroute',
    title: 'Approved - awaiting author',
    order: 100,
    mention: 'owner',
    subGroupByPriority: true,
  },

  // ── Review gates: an approved PR is re-routed OUT of these ────────────────
  changeRequest: {
    role: 'reviewGate',
    title: 'Changes requested',
    order: 110,
    mention: 'owner',
    subGroupByPriority: true,
  },
  awaitingSpecialReview: {
    role: 'reviewGate',
    title: 'Awaiting devops review',
    order: 120,
    mention: 'roleRoster',
    roleKey: 'devops_',
    specificOwner: 'requestedReviewer',
    subGroupByPriority: true,
  },
  awaitingReview: {
    role: 'reviewGate',
    title: 'Awaiting review',
    order: 130,
    mention: 'roleRoster',
    roleKey: 'reviewer_',
    specificOwner: 'requestedReviewer',
    subGroupByPriority: true,
  },
  reviewOngoing: {
    role: 'reviewGate',
    title: 'Review in progress',
    order: 140,
    mention: 'roleRoster',
    roleKey: 'reviewer_',
    specificOwner: 'requestedReviewer',
    subGroupByPriority: true,
  },
  readyForMerge: {
    role: 'reviewGate',
    title: 'Ready to merge',
    order: 150,
    mention: 'owner',
    subGroupByPriority: true,
  },

  // ── Generic approved: checked after every more-specific state ─────────────
  approved: {
    role: 'approvedGeneric',
    title: 'Approved',
    order: 160,
    mention: 'owner',
    subGroupByPriority: false,
  },

  // ── Title fallbacks, after all label matching ─────────────────────────────
  dependencies: {
    role: 'standalone',
    title: 'Dependency updates',
    order: 170,
    mention: 'owner',
    subGroupByPriority: false,
  },
  inProgress: {
    role: 'standalone',
    title: 'In progress',
    order: 180,
    mention: 'owner',
    subGroupByPriority: false,
  },

  // ── Catch-all: the totality guarantee ─────────────────────────────────────
  none: {
    role: 'catchAll',
    title: 'Uncategorized',
    order: 190,
    mention: 'owner',
    subGroupByPriority: false,
  },
};
