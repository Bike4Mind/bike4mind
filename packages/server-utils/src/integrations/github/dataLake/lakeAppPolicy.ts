import type { GitHubLakeInstallationPolicyViolation } from '@bike4mind/common';
import type { GitHubLakeInstallation } from './lakeAppClient';

/**
 * What an installation may grant. The App is registered with exactly these, but an App owner can
 * widen its permissions later and an account owner can accept that, so each connect re-checks the
 * live installation instead of trusting the registration.
 */
const ALLOWED_PERMISSIONS: Readonly<Record<string, 'read'>> = { contents: 'read', metadata: 'read' };

export function findInstallationPolicyViolation(
  installation: Pick<GitHubLakeInstallation, 'repositorySelection' | 'permissions'>
): GitHubLakeInstallationPolicyViolation | null {
  if (installation.repositorySelection !== 'selected') return 'all_repositories';
  const granted = Object.entries(installation.permissions).filter(([, level]) => level !== undefined);
  if (granted.some(([name, level]) => ALLOWED_PERMISSIONS[name] !== level)) return 'excess_permissions';
  if (installation.permissions.contents !== 'read') return 'missing_contents_read';
  return null;
}
