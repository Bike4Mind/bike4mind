import { cacheRepository, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { z } from 'zod';

const REVOCATION_EVENTS: ReadonlySet<string> = new Set(['installation', 'installation_repositories']);

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

// GitHub always names the removed repositories on `removed`; an empty or absent list is malformed,
// not a no-op, so a broken delivery surfaces as a 400 instead of a silent `queued: 0`.
const InstallationRepositoriesRemovedEvent = InstallationEvent.extend({
  repositories_removed: z.array(z.object({ id: z.number() })).min(1),
});

/** A revoke scoped to the whole installation (`repositoryIds: null`) or to the named repositories. */
export type GitHubLakeRevocationTarget = { installationId: number; repositoryIds: ReadonlySet<number> | null };

/** The event types that can carry a revoke; parseGitHubLakeRevocation still decides by action. */
export const isGitHubLakeRevocationEvent = (eventType: string | undefined): boolean =>
  eventType !== undefined && REVOCATION_EVENTS.has(eventType);

/**
 * What a data-lake App webhook delivery (webhooks/github/lake.ts) revokes, without touching the
 * database - so an ignored action never opens a connection - or null when the
 * event/action is not one we act on: `installation.deleted` revokes the whole installation,
 * `installation_repositories.removed` only the removed repositories.
 */
export function parseGitHubLakeRevocation(
  eventType: string | undefined,
  payload: unknown
): GitHubLakeRevocationTarget | { malformed: string } | null {
  if (!isGitHubLakeRevocationEvent(eventType)) return null;
  const event = InstallationEvent.safeParse(payload);
  if (!event.success) return { malformed: event.error.message };
  const installationId = event.data.installation.id;

  if (eventType === 'installation') {
    return event.data.action === 'deleted' ? { installationId, repositoryIds: null } : null;
  }

  if (event.data.action !== 'removed') return null;
  const removed = InstallationRepositoriesRemovedEvent.safeParse(payload);
  if (!removed.success) return { malformed: removed.error.message };
  return { installationId, repositoryIds: new Set(removed.data.repositories_removed.map(repo => repo.id)) };
}

/** The lake connections a parsed revoke applies to. Needs a database connection. */
export async function findRevokedConnectionIds({
  installationId,
  repositoryIds,
}: GitHubLakeRevocationTarget): Promise<string[]> {
  const bindings = await orgGitHubLakeConnectionRepository.findByInstallationId(installationId);
  return bindings
    .filter(binding => repositoryIds === null || repositoryIds.has(binding.repositoryId))
    .map(binding => binding.id);
}

// Outlasts GitHub's 3-day window for manually redelivering a webhook delivery.
const RESOLVED_DELIVERY_TTL_MS = 4 * 24 * 60 * 60 * 1000;

const ResolvedDelivery = z.object({ connectionIds: z.array(z.string()) });

const resolvedDeliveryKey = (deliveryId: string) => `github-lake-revoke-delivery-${deliveryId}`;

/**
 * findRevokedConnectionIds, pinned to the delivery: the first delivery's answer is stored under its
 * `x-github-delivery` id, and a redelivery of that id reuses it instead of re-reading live bindings.
 * Re-resolving would match a connection the user made after re-granting the repository and purge it.
 * Pinned before anything is enqueued, so a redelivery after a partial enqueue failure re-sends the
 * same set (revokes are idempotent per connection). Needs a database connection.
 */
export async function resolveRevokedConnectionIds(
  target: GitHubLakeRevocationTarget,
  deliveryId: string
): Promise<string[]> {
  const key = resolvedDeliveryKey(deliveryId);
  const pinned = await cacheRepository.findByKey(key);
  if (pinned) {
    const parsed = ResolvedDelivery.safeParse(pinned.result);
    if (parsed.success) return parsed.data.connectionIds;
  }

  const connectionIds = await findRevokedConnectionIds(target);
  await cacheRepository.createOrUpdate({
    key,
    result: { connectionIds },
    expiresAt: new Date(Date.now() + RESOLVED_DELIVERY_TTL_MS),
  });
  return connectionIds;
}
