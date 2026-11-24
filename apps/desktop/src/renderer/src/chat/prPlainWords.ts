import type { PrAttention, PrIconStatus } from '@shared/prAttention';
import { countChecks, type PrBarSnapshot, type PrDisplayState } from '@shared/pullRequest';
import { timeAgo } from './prBarModel';

/*
 * The PR icon's state spelled out for someone who has not learned the glyphs yet. It reads only the
 * PrIconStatus that prAttention already computed, so these words can never disagree with the icon.
 */

export interface PrHeadline {
  title: string;
  /** What, if anything, it takes to move the PR along. */
  hint?: string;
}

const ATTENTION_WORDS: Record<PrAttention, PrHeadline> = {
  conflict: { title: 'Merge conflict', hint: 'Needs a rebase onto the base branch.' },
  ciFailed: { title: 'CI failed', hint: 'A check is failing; see the failing checks on GitHub.' },
  changesRequested: { title: 'Changes requested', hint: 'A reviewer asked for changes before it can merge.' },
  ciRunning: { title: 'CI running', hint: 'Waiting for checks to finish.' },
  awaitingReview: { title: 'Awaiting review', hint: 'Needs an approving review.' },
  approvedBlocked: {
    title: 'Approved but blocked',
    hint: 'A branch rule or required check is holding the merge.',
  },
  ready: { title: 'Ready to merge', hint: 'Approved and passing; nothing is blocking it.' },
};

const STATE_WORDS: Record<PrDisplayState, PrHeadline> = {
  open: { title: 'Open' },
  draft: { title: 'Draft', hint: 'Not marked ready for review yet.' },
  queued: { title: 'Queued to merge', hint: 'Will merge once the queue reaches it.' },
  merged: { title: 'Merged' },
  closed: { title: 'Closed', hint: 'Closed without merging.' },
};

export function prHeadline(status: PrIconStatus): PrHeadline {
  if (status.state === 'open' && status.attention) return ATTENTION_WORDS[status.attention];
  return STATE_WORDS[status.state];
}

/** The glyph legend, in the order prAttention ranks them (worst first), then the lifecycle states. */
export const PR_LEGEND: readonly { status: PrIconStatus; label: string }[] = [
  ...(
    ['conflict', 'ciFailed', 'changesRequested', 'ciRunning', 'awaitingReview', 'approvedBlocked', 'ready'] as const
  ).map(attention => ({ status: { state: 'open', attention } as const, label: ATTENTION_WORDS[attention].title })),
  { status: { state: 'open', behind: true }, label: 'Behind the base branch' },
  { status: { state: 'open', autoMerge: true }, label: 'Auto-merge on' },
  ...(['draft', 'queued', 'merged', 'closed'] as const).map(state => ({
    status: { state },
    label: STATE_WORDS[state].title,
  })),
];

/** "3 passed, 1 failed, 2 running"; skipped checks are left out unless they are all there is. */
export function ciLine(checks: PrBarSnapshot['checks']): string {
  if (checks.length === 0) return 'No checks';
  const counts = countChecks(checks);
  const parts = [
    counts.pass > 0 ? `${counts.pass} passed` : null,
    counts.fail > 0 ? `${counts.fail} failed` : null,
    counts.pending > 0 ? `${counts.pending} running` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : `${counts.skipped} skipped`;
}

export function reviewLine(decision: PrBarSnapshot['reviewDecision']): string {
  switch (decision) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes requested';
    case 'REVIEW_REQUIRED':
      return 'Review required';
    default:
      return 'No review required';
  }
}

export function mergeLine(
  snapshot: Pick<PrBarSnapshot, 'state' | 'mergeable' | 'mergeStateStatus' | 'baseRefName'>
): string {
  if (snapshot.state !== 'OPEN') return snapshot.state === 'MERGED' ? `Merged into ${snapshot.baseRefName}` : 'Closed';
  if (snapshot.mergeable === 'CONFLICTING' || snapshot.mergeStateStatus === 'DIRTY')
    return `Conflicts with ${snapshot.baseRefName}`;
  if (snapshot.mergeStateStatus === 'BEHIND') return `Behind ${snapshot.baseRefName}; the branch needs an update`;
  if (snapshot.mergeable === 'UNKNOWN') return 'GitHub is still checking mergeability';
  return `No conflicts with ${snapshot.baseRefName}`;
}

/** When the card's data is from: the merge for a merged PR, otherwise the app's last read of it. */
export function freshnessLine(snapshot: Pick<PrBarSnapshot, 'fetchedAt' | 'mergedAt'>, now: number): string | null {
  if (snapshot.mergedAt) {
    const ago = timeAgo(snapshot.mergedAt, now);
    return ago ? `Merged ${ago}` : null;
  }
  const ago = timeAgo(new Date(snapshot.fetchedAt).toISOString(), now);
  return ago ? `Checked ${ago}` : null;
}

/** The PR page, from the `owner/repo` the summary carries; undefined when it has none. */
export function prPageUrl(repo: string | undefined, number: number): string | undefined {
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pull/${number}` : undefined;
}
