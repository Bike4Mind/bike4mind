import type { PrMergeMethod, PrSnapshot } from '@shared/pullRequest';
import { mergeMethodFor } from './github';

export type MergeReadiness = { ready: true; method: PrMergeMethod } | { ready: false; reason: string };

/** mergeStateStatus values under which GitHub itself says branch protection is satisfied. */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * Whether this app may merge the PR now, for a repo where GitHub's own auto-merge is off.
 *
 * Deliberately stricter than GitHub's minimum, because this path has no GitHub-side gate of
 * its own: the PR must be approved, have no conflicts, every required check must have passed,
 * and nothing may be failing or still running at all - GitHub's UNSTABLE (mergeable, but a
 * non-required check failing) is a no. Branch protection is still GitHub's to enforce at merge
 * time; this only decides when to ask, and the merge itself never passes --admin.
 */
export function desktopMergeReadiness(snapshot: PrSnapshot): MergeReadiness {
  if (snapshot.state !== 'OPEN') return { ready: false, reason: 'The pull request is not open.' };
  if (snapshot.isDraft) return { ready: false, reason: 'Waiting: still a draft.' };
  if (snapshot.mergeable === 'CONFLICTING') return { ready: false, reason: 'Waiting: has conflicts.' };
  if (snapshot.mergeable !== 'MERGEABLE') return { ready: false, reason: 'Waiting: GitHub is checking mergeability.' };
  if (snapshot.reviewDecision !== 'APPROVED') return { ready: false, reason: 'Waiting: needs an approving review.' };

  const required = snapshot.checks.filter(check => check.required);
  if (required.some(check => check.bucket !== 'pass' && check.bucket !== 'skipped')) {
    return { ready: false, reason: 'Waiting: required checks have not all passed.' };
  }
  if (snapshot.checks.some(check => check.bucket === 'pending'))
    return { ready: false, reason: 'Waiting: checks are running.' };
  if (snapshot.checks.some(check => check.bucket === 'fail'))
    return { ready: false, reason: 'Waiting: a check is failing.' };
  if (!MERGEABLE_STATES.has(snapshot.mergeStateStatus)) {
    return { ready: false, reason: `Waiting: GitHub reports ${snapshot.mergeStateStatus.toLowerCase()}.` };
  }

  const method = mergeMethodFor(snapshot);
  if (!method) return { ready: false, reason: 'This repository allows no merge method.' };
  return { ready: true, method };
}
