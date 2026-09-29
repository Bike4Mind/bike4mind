import type { GitHubLakeInstallation, GitHubLakeRepository } from './lakeAppClient';

/**
 * What an installation may grant. The App is registered with exactly these, but an App owner can
 * widen its permissions later and an account owner can accept that, so each connect re-checks the
 * live installation instead of trusting the registration.
 */
const ALLOWED_PERMISSIONS: Readonly<Record<string, 'read'>> = { contents: 'read', metadata: 'read' };

export type InstallationPolicyViolation = 'all_repositories' | 'excess_permissions' | 'missing_contents_read';

export function findInstallationPolicyViolation(
  installation: Pick<GitHubLakeInstallation, 'repositorySelection' | 'permissions'>
): InstallationPolicyViolation | null {
  if (installation.repositorySelection !== 'selected') return 'all_repositories';
  const granted = Object.entries(installation.permissions).filter(([, level]) => level !== undefined);
  if (granted.some(([name, level]) => ALLOWED_PERMISSIONS[name] !== level)) return 'excess_permissions';
  if (installation.permissions.contents !== 'read') return 'missing_contents_read';
  return null;
}

export type RepositoryPick =
  | { kind: 'picked'; repository: GitHubLakeRepository }
  | { kind: 'none_unbound' }
  | { kind: 'ambiguous'; unboundCount: number };

/**
 * One installation can serve several lakes (one per GitHub account), so the repository to bind is
 * the single one the installer can see that no lake has claimed yet. Zero or several is ambiguous
 * and is refused rather than guessed.
 */
export function pickRepositoryToBind(
  visibleRepositories: readonly GitHubLakeRepository[],
  boundRepositoryIds: ReadonlySet<number>
): RepositoryPick {
  const unbound = visibleRepositories.filter(repo => !boundRepositoryIds.has(repo.id));
  if (unbound.length === 0) return { kind: 'none_unbound' };
  if (unbound.length > 1) return { kind: 'ambiguous', unboundCount: unbound.length };
  return { kind: 'picked', repository: unbound[0] };
}
