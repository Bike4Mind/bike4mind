import { SECOPS_TRIAGE_REPO_PATTERN } from '@bike4mind/common';
import type { GitHubService } from '../services/githubService';

export type SecopsTriageRepoIssue =
  'not_configured' | 'not_allowed' | 'not_found' | 'public' | 'archived' | 'issues_disabled';

export type SecopsTriageRepoCheck = { ok: true } | { ok: false; reason: SecopsTriageRepoIssue };

/**
 * Whether SecOps triage can file issues in `repo` through this connection. Shared by the triage
 * worker and the admin status endpoint so both report the same reason. A failed GitHub lookup
 * throws: it is transient, not a property of the repository.
 */
export async function checkSecopsTriageRepo(
  githubService: Pick<GitHubService, 'isRepositoryAllowed' | 'getRepository'>,
  repo: string
): Promise<SecopsTriageRepoCheck> {
  if (!SECOPS_TRIAGE_REPO_PATTERN.test(repo)) return { ok: false, reason: 'not_configured' };
  if (!githubService.isRepositoryAllowed(repo)) return { ok: false, reason: 'not_allowed' };

  const repository = await githubService.getRepository(repo);
  if (!repository) return { ok: false, reason: 'not_found' };
  // Scan findings are not for a public issue tracker.
  if (!repository.private) return { ok: false, reason: 'public' };
  if (repository.archived === true) return { ok: false, reason: 'archived' };
  if (repository.has_issues === false) return { ok: false, reason: 'issues_disabled' };
  return { ok: true };
}
