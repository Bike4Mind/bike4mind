import type { BulkAbuseTarget } from '@bike4mind/common';
import {
  authSessionRepository,
  creditTransactionRepository,
  organizationRepository,
  realtimeConnectionRepository,
  trustedDeviceRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import type { abuseService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { denySelfAdminAction, isSelfOrImpersonator, recordAdminActionFromRequest } from '@server/utils/adminAudit';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];
type Actor = { id: string; email?: string | null; username?: string };

export const bulkAbuseCohortAdapters: abuseService.BulkAbuseCohortAdapters = {
  db: { users: userRepository, organizations: organizationRepository, creditTransactions: creditTransactionRepository },
};

export const bulkAbusePreviewAdapters: abuseService.BulkAbusePreviewAdapters = {
  db: { userApiKeys: userApiKeyRepository, creditTransactions: creditTransactionRepository },
};

/** Execute adapters whose audit entries carry the request's actor and the admin's reason. */
export function bulkAbuseExecuteAdapters(
  req: AuditRequest,
  reason: string,
  logger?: Logger
): abuseService.BulkAbuseExecuteAdapters {
  return {
    db: {
      users: userRepository,
      userApiKeys: userApiKeyRepository,
      authSessions: authSessionRepository,
      realtimeConnections: realtimeConnectionRepository,
      trustedDevices: trustedDeviceRepository,
      creditTransactions: creditTransactionRepository,
    },
    withTransaction: fn => withTransaction(() => fn(), { logger }),
    audit: ({ action, user, summary, changes, details, related }) =>
      recordAdminActionFromRequest(req, {
        action,
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        summary,
        reason,
        changes,
        details,
        related,
      }),
    logger,
  };
}

/**
 * An explicit user list naming the acting admin (or the user they impersonate) is refused and
 * audited, as every single-user admin action does. A domain target only ever skips the admin, as
 * an admin account is excluded from any cohort.
 */
export async function denySelfInBulkAbuseTarget(
  req: AuditRequest,
  actor: Actor,
  target: BulkAbuseTarget
): Promise<void> {
  if (target.kind !== 'users') return;
  const selfId = target.userIds.find(id => isSelfOrImpersonator(actor, id));
  if (!selfId) return;
  await denySelfAdminAction(req, {
    action: 'abuse.bulk.denied',
    attempted: 'abuse.bulk.executed',
    target: { kind: 'user', id: selfId, displayName: actor.email ?? actor.username ?? selfId },
    message: 'A bulk abuse response cannot include your own account.',
  });
}
