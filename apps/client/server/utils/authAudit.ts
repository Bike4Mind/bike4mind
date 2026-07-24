import type { Request } from 'express';
import { userAuthAuditLogRepository, type UserAuthAuditEvent } from '@bike4mind/database';
import { getClientIp } from '@server/utils/ip';

/**
 * Write an account-level authentication event to the forensic audit log.
 *
 * Best-effort by design: a logging failure must never break the auth flow it
 * is recording, so all errors are swallowed (mirrors the existing logEvent
 * call sites). Login *failures* are NOT routed here - those belong to
 * AuthFailLog and must not be duplicated.
 */
export async function logAuthAudit(
  // any: express Request generics vary across call sites (asyncHandler-wrapped
  // handlers narrow `params` to `unknown`); we only read headers/socket/
  // requestId, all invariant to those generics.
  req: Request<any, any, any, any, any>,
  params: {
    userId: string;
    event: UserAuthAuditEvent;
    strategy?: string;
    /** The user who performed the action, when it differs from `userId` (e.g. an admin force-logout). */
    actorUserId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await userAuthAuditLogRepository.createLog({
      userId: params.userId,
      event: params.event,
      strategy: params.strategy,
      actorUserId: params.actorUserId,
      actorIp: getClientIp(req) || 'unknown',
      userAgent: (req.headers['user-agent'] as string) || 'unknown',
      requestId: req.requestId,
      metadata: params.metadata,
    });
  } catch (err) {
    console.debug(`Failed to write UserAuthAuditLog (${params.event}):`, err);
  }
}
