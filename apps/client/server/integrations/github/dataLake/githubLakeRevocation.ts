import { orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { z } from 'zod';

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

// GitHub always names the removed repositories on `removed`; an empty or absent list is malformed,
// not a no-op, so a broken delivery surfaces as a 400 instead of a silent `queued: 0`.
const InstallationRepositoriesRemovedEvent = InstallationEvent.extend({
  repositories_removed: z.array(z.object({ id: z.number() })).min(1),
});

export type GitHubLakeRevocation = { installationId: number; connectionIds: string[] };

export type GitHubLakeRevocationResult = GitHubLakeRevocation | { malformed: string } | null;

/**
 * The lake connections a data-lake App webhook delivery revokes (webhooks/github/lake.ts), or
 * null when the event/action is not one we act on: `installation.deleted` revokes every binding of
 * the installation, `installation_repositories.removed` only the bindings of the removed repositories.
 */
export async function resolveGitHubLakeRevocation(
  eventType: string | undefined,
  payload: unknown
): Promise<GitHubLakeRevocationResult> {
  if (eventType !== 'installation' && eventType !== 'installation_repositories') return null;
  const event = InstallationEvent.safeParse(payload);
  if (!event.success) return { malformed: event.error.message };
  const installationId = event.data.installation.id;

  if (eventType === 'installation') {
    if (event.data.action !== 'deleted') return null;
    const bindings = await orgGitHubLakeConnectionRepository.findByInstallationId(installationId);
    return { installationId, connectionIds: bindings.map(binding => binding.id) };
  }

  if (event.data.action !== 'removed') return null;
  const removed = InstallationRepositoriesRemovedEvent.safeParse(payload);
  if (!removed.success) return { malformed: removed.error.message };
  const removedRepositoryIds = new Set(removed.data.repositories_removed.map(repo => repo.id));
  const bindings = await orgGitHubLakeConnectionRepository.findByInstallationId(installationId);
  return {
    installationId,
    connectionIds: bindings
      .filter(binding => removedRepositoryIds.has(binding.repositoryId))
      .map(binding => binding.id),
  };
}
