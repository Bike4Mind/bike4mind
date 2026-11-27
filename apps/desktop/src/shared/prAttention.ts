import { ciSummary, prDisplayState, type PrBarSnapshot, type PrDisplayState } from './pullRequest';

/**
 * What an open PR is waiting on, worst first: the order is the priority when several apply, and
 * the sidebar's "needs attention" sort ranks by it.
 */
export const PR_ATTENTIONS = [
  'conflict',
  'ciFailed',
  'changesRequested',
  'ciRunning',
  'awaitingReview',
  'approvedBlocked',
  'ready',
] as const;

export type PrAttention = (typeof PR_ATTENTIONS)[number];

export function isPrAttention(value: unknown): value is PrAttention {
  return typeof value === 'string' && (PR_ATTENTIONS as readonly string[]).includes(value);
}

export type PrAttentionInput = Pick<
  PrBarSnapshot,
  'state' | 'isDraft' | 'mergeable' | 'mergeStateStatus' | 'reviewDecision' | 'checks'
>;

/** Merge states in which GitHub would take the merge now; BEHIND is shown as its own badge. */
const MERGEABLE_NOW = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND']);

/**
 * The one thing an open, non-draft PR is waiting on; null for a draft, a finished PR, or while
 * GitHub is still computing mergeability (nothing honest to say yet).
 *
 * CI reads checks through ciSummary, the same reduction as the CI popover's dot: any failing
 * check counts, required or not, so the icon and the dot can never disagree.
 */
export function prAttentionOf(snapshot: PrAttentionInput): PrAttention | null {
  if (snapshot.state !== 'OPEN' || snapshot.isDraft) return null;
  if (snapshot.mergeable === 'CONFLICTING' || snapshot.mergeStateStatus === 'DIRTY') return 'conflict';
  const ci = ciSummary(snapshot.checks);
  if (ci === 'fail') return 'ciFailed';
  if (snapshot.reviewDecision === 'CHANGES_REQUESTED') return 'changesRequested';
  if (ci === 'pending') return 'ciRunning';
  if (snapshot.reviewDecision === 'REVIEW_REQUIRED') return 'awaitingReview';
  // Past here the review is approved or not required (GitHub reports null when none is).
  if (snapshot.mergeable === 'UNKNOWN') return null;
  if (snapshot.mergeStateStatus === 'BLOCKED') return 'approvedBlocked';
  return MERGEABLE_NOW.has(snapshot.mergeStateStatus) ? 'ready' : null;
}

/** What the PR icon draws, for the bar and the sidebar alike. See PrStateIcon. */
export interface PrIconStatus {
  state: PrDisplayState;
  /** Only for an `open` PR. */
  attention?: PrAttention;
  behind?: boolean;
  /** Will merge without another click: GitHub auto-merge armed, in the merge queue, or held by this app. */
  autoMerge?: boolean;
  /** Last known from the binding file, not read this launch. */
  stale?: boolean;
}

/**
 * The icon fields from one read. Extras are left off rather than set false, so a summary that
 * has none stays the plain `{ number, state, repo }` it always was.
 */
export function prIconStatus(
  snapshot: PrAttentionInput & Pick<PrBarSnapshot, 'autoMergeArmed' | 'mergeQueue'>,
  { queued, appAutoMerge }: { queued: boolean; appAutoMerge: boolean }
): PrIconStatus {
  const state = prDisplayState(snapshot.state, snapshot.isDraft, queued);
  if (state !== 'open') return { state };
  const attention = prAttentionOf(snapshot);
  const autoMerge = snapshot.autoMergeArmed || !!snapshot.mergeQueue?.entry || appAutoMerge;
  return {
    state,
    ...(attention ? { attention } : {}),
    ...(snapshot.mergeStateStatus === 'BEHIND' ? { behind: true } : {}),
    ...(autoMerge ? { autoMerge: true } : {}),
  };
}

/**
 * Sort key for the "needs attention" order, lower first: an open PR by its attention, then any
 * other live PR, then sessions with no PR or a finished one.
 */
export function prAttentionRank(pr: PrIconStatus | undefined): number {
  if (!pr || pr.state === 'merged' || pr.state === 'closed') return PR_ATTENTIONS.length + 1;
  return pr.attention ? PR_ATTENTIONS.indexOf(pr.attention) : PR_ATTENTIONS.length;
}
