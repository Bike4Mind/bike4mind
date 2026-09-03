/**
 * PR report generator - the classifier.
 *
 * A pure, side-effect-free function `PullRequest -> Bucket`, implemented as an
 * ordered sequence of guards where the first match wins. The ORDER is the design:
 * it encodes workflow rules a flat label→bucket map cannot express, because those
 * rules are relationships between signals rather than properties of one label.
 *
 * Deterministic and network-free so every rule and every tie-break can be pinned
 * by a fixture - see bucketFor.test.ts.
 */

import {
  BUCKET_LABELS,
  DEPENDENCY_TITLE_PATTERN,
  PRIORITY_LABELS,
  WIP_TITLE_PATTERN,
  BUCKET_SPECS,
} from './bucketSpecs';
import type { Bucket, PriorityTier, PullRequest } from './types';

/** Case-insensitive label membership. */
function hasAnyLabel(pr: PullRequest, bucket: Bucket): boolean {
  const wanted = BUCKET_LABELS[bucket];
  if (!wanted?.length) return false;

  const present = pr.labels.map(label => label.trim().toLowerCase());
  return wanted.some(label => present.includes(label.toLowerCase()));
}

/**
 * Assign a PR to exactly one bucket.
 *
 * The guard order below is load-bearing; reordering two checks silently changes
 * categorization. Read it as a whole.
 */
export function bucketFor(pr: PullRequest): Bucket {
  // 1. Short-circuits. Special PRs outside the review/QA flow, matched before
  //    anything else so they never leak into a workflow section. Draft beats every
  //    label: a draft is not up for review no matter what it is tagged with.
  if (hasAnyLabel(pr, 'release')) return 'release';
  if (pr.isDraft) return 'draft';

  // 2. Testing states, checked BEFORE any approval-sensitive state. A PR being
  //    tested stays in its testing section even after its code is approved -
  //    review approval is not QA sign-off.
  if (hasAnyLabel(pr, 'qaInProgress')) return 'qaInProgress';
  if (hasAnyLabel(pr, 'awaitingTesting')) return 'awaitingTesting';
  if (hasAnyLabel(pr, 'qaClarification')) return 'qaClarification';

  // 3. Standalone states. Approval does NOT re-route these - the author already
  //    has agreed work to do, so an approving review does not change whose move it
  //    is. mergeConflict sits ahead of readyForMerge deliberately: a conflicted
  //    `qa_passed` PR is blocked, not ready.
  if (hasAnyLabel(pr, 'qaFailed')) return 'qaFailed';
  if (hasAnyLabel(pr, 'mergeConflict')) return 'mergeConflict';
  if (hasAnyLabel(pr, 'awaitingFix')) return 'awaitingFix';
  if (hasAnyLabel(pr, 'onHold')) return 'onHold';

  // 4. Review gates. An approved PR is re-routed OUT of these into
  //    'approvedAwaitingAuthor', because the gate label is now stale and the ball
  //    is in the author's court.
  //
  //    `isApproved` is three-state: only an explicit `true` re-routes. `undefined`
  //    means the approval source was unavailable, and treating unknown as approved
  //    would invent a routing the data does not support (the mirror of the
  //    unknown-as-false bug that files approved PRs back under "awaiting review").
  const reviewGate = REVIEW_GATE_ORDER.find(bucket => hasAnyLabel(pr, bucket));
  if (reviewGate) {
    return pr.isApproved === true ? 'approvedAwaitingAuthor' : reviewGate;
  }

  // 5. Generic approved, after every more-specific state above.
  if (hasAnyLabel(pr, 'approved')) return 'approved';

  // 6. Title fallbacks, after all label matching, so a labelled PR keeps its
  //    labelled bucket while an unlabelled one is still categorized.
  if (hasAnyLabel(pr, 'dependencies') || DEPENDENCY_TITLE_PATTERN.test(pr.title)) return 'dependencies';
  if (WIP_TITLE_PATTERN.test(pr.title)) return 'inProgress';

  // 7. Catch-all. Total by construction: no open PR the classifier receives can
  //    silently vanish from the digest. (A PR CAN go missing upstream of here - the
  //    page-walk bound - which is why that path surfaces `truncated` loudly rather
  //    than dropping PRs below this guarantee.)
  return 'none';
}

/**
 * The review-gate buckets in precedence order, derived from the specs rather than
 * restated, so adding a gate to BUCKET_SPECS cannot leave the classifier behind.
 */
const REVIEW_GATE_ORDER: Bucket[] = (Object.keys(BUCKET_SPECS) as Bucket[])
  .filter(bucket => BUCKET_SPECS[bucket].role === 'reviewGate')
  .sort((a, b) => BUCKET_SPECS[a].order - BUCKET_SPECS[b].order);

/** Detect a priority tier from the PR's labels, or null when none is present. */
export function priorityTierFor(pr: PullRequest): PriorityTier {
  const present = pr.labels.map(label => label.trim().toLowerCase());
  return PRIORITY_LABELS.find(tier => present.includes(tier.toLowerCase())) ?? null;
}
