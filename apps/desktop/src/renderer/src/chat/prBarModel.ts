import type { PrBarState, PrGhStatus } from '@shared/pullRequest';
import { ciSummary } from '@shared/pullRequest';

/** Keep both ends of a long branch name: the type prefix and the distinguishing tail. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
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
