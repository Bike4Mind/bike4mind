import type { PrBarState, PrCheckBucket, PrGhStatus } from '@shared/pullRequest';
import { ciSummary, countChecks } from '@shared/pullRequest';

/** Keep both ends of a long branch name: the type prefix and the distinguishing tail. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 3;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}...${text.slice(text.length - (keep - head))}`;
}

/** The one line the bar shows instead of a PR when `gh` cannot be used. */
export function ghFixLine(gh: PrGhStatus): string | null {
  if (gh === 'missing') return 'GitHub CLI not found. Install it (brew install gh), run gh auth login, then refresh.';
  if (gh === 'unauthenticated') return 'GitHub CLI is not signed in. Run gh auth login in a terminal, then refresh.';
  return null;
}

export type CiDot = 'none' | 'pending' | 'pass' | 'fail';

/** Joy palette tokens, chosen because each reads on both the light and the dark surface. */
export const CI_DOT_COLOR: Record<CiDot, string> = {
  none: 'neutral.outlinedBorder',
  pending: 'warning.400',
  pass: 'success.500',
  fail: 'danger.500',
};

export function ciDot(state: PrBarState): CiDot {
  return state.snapshot ? ciSummary(state.snapshot.checks) : 'none';
}

/** Merged and closed replace the CI control: nothing is running any more. */
export function lifecycleLabel(state: PrBarState): 'Merged' | 'Closed' | 'Draft' | null {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  if (snapshot.state === 'MERGED') return 'Merged';
  if (snapshot.state === 'CLOSED') return 'Closed';
  return snapshot.isDraft ? 'Draft' : null;
}

type Snapshot = NonNullable<PrBarState['snapshot']>;

/** The popover's count rows, in the order the reference reads them. Failed only when there are any. */
export function checkRows(snapshot: Snapshot): { bucket: PrCheckBucket; label: string; count: number }[] {
  const counts = countChecks(snapshot.checks);
  const rows: { bucket: PrCheckBucket; label: string; count: number }[] = [
    { bucket: 'pending', label: 'In progress', count: counts.pending },
    { bucket: 'pass', label: 'Passed', count: counts.pass },
  ];
  if (counts.fail > 0) rows.push({ bucket: 'fail', label: 'Failed', count: counts.fail });
  if (counts.skipped > 0) rows.push({ bucket: 'skipped', label: 'Skipped', count: counts.skipped });
  return rows;
}

export const BUCKET_DOT: Record<PrCheckBucket, string> = {
  pending: CI_DOT_COLOR.pending,
  pass: CI_DOT_COLOR.pass,
  fail: CI_DOT_COLOR.fail,
  skipped: 'neutral.400',
};

/** Failures first, then what is still running: the order a reader scans for trouble in. */
export function sortedChecks(snapshot: Snapshot): Snapshot['checks'] {
  const rank: Record<PrCheckBucket, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  return [...snapshot.checks].sort((a, b) => rank[a.bucket] - rank[b.bucket] || a.name.localeCompare(b.name));
}

export function reviewLabel(snapshot: Snapshot): string {
  switch (snapshot.reviewDecision) {
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

/** Mergeability in words. GitHub computes it lazily, so UNKNOWN is "still working it out". */
export function mergeLabel(snapshot: Snapshot): { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  if (snapshot.mergeable === 'CONFLICTING') return { text: 'Has conflicts with the base branch', tone: 'danger' };
  if (snapshot.mergeable === 'UNKNOWN') return { text: 'Checking mergeability...', tone: 'neutral' };
  switch (snapshot.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { text: 'Ready to merge', tone: 'success' };
    case 'BEHIND':
      return { text: 'Behind the base branch', tone: 'warning' };
    case 'BLOCKED':
      return { text: 'Blocked by branch protection', tone: 'warning' };
    case 'UNSTABLE':
      return { text: 'Mergeable, with failing checks', tone: 'warning' };
    case 'DRAFT':
      return { text: 'Draft', tone: 'neutral' };
    default:
      return { text: 'No conflicts', tone: 'neutral' };
  }
}
