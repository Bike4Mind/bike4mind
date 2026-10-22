import type { PrMergeMethod, PrSnapshot } from '@shared/pullRequest';
import { mergeMethodFor } from './github';

/** Ready to go `via` the base branch's merge queue, or by a direct merge with `method`. */
export type MergeReadiness =
  | { ready: true; via: 'queue' }
  | { ready: true; via: 'merge'; method: PrMergeMethod }
  | { ready: false; reason: string };

/** mergeStateStatus values under which GitHub itself says branch protection is satisfied. */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * Whether this app may merge the PR now, for a repo where GitHub's own auto-merge is off.
 *
 * Deliberately stricter than GitHub's minimum, because this path has no GitHub-side gate of
 * its own: the PR must be approved, have no conflicts, every required check must have passed,
 * and nothing may be failing or still running at all - GitHub's UNSTABLE (mergeable, but a
 * non-required check failing) is a no. "Every check" is the latest run of each, as GitHub counts
 * them (see latestCheckRuns). Approval is GitHub's reviewDecision, so a reviewer still requested
 * after the required approvals are in does not hold it up. Branch protection is still GitHub's
 * to enforce at merge time; this only decides when to ask, and the merge never passes --admin.
 *
 * A base branch with a merge queue takes no direct merge, so readiness there means "enqueue";
 * the queue merges with its own method, so the repo's allowed methods do not matter.
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

  if (snapshot.mergeQueue?.enabled) return { ready: true, via: 'queue' };
  const method = mergeMethodFor(snapshot);
  if (!method) return { ready: false, reason: 'This repository allows no merge method.' };
  return { ready: true, via: 'merge', method };
}
