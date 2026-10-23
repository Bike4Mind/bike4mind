import type { Request } from 'express';
import { userAuthAuditLogRepository, type UserAuthAuditEvent } from '@bike4mind/database';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { recordSessionReuseRevoked, recordSessionRecovered } from '@bike4mind/server-utils/utils/cloudwatch';

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
  const actorIp = getClientIp(req) || 'unknown';
  const userAgent = (req.headers['user-agent'] as string) || 'unknown';
  const metadata =
    params.event === 'session_reuse_revoked' ? withIssuedIpComparison(params.metadata, actorIp) : params.metadata;
  if (params.event === 'session_reuse_revoked') {
    // One self-contained line, so the alarm can be triaged from the Lambda log without a database
    // lookup. The audit row below carries the same fields.
    console.warn('[auth] session_reuse_revoked', { userId: params.userId, actorIp, userAgent, ...metadata });
  }
  try {
    await userAuthAuditLogRepository.createLog({
      userId: params.userId,
      event: params.event,
      strategy: params.strategy,
      actorUserId: params.actorUserId,
      actorIp,
      userAgent,
      requestId: req.requestId,
      metadata,
    });
  } catch (err) {
    console.debug(`Failed to write UserAuthAuditLog (${params.event}):`, err);
  }
  // Awaited: both counts feed alarms (infra/alarms.ts), and a frozen Lambda loses a pending emit.
  // Neither is on the common refresh path - a revoke rejects the request and a recovery is a rare
  // retry after a lost rotation response - so the extra round trip is affordable. Never rejects.
  if (params.event === 'session_reuse_revoked') await recordSessionReuseRevoked();
  else if (params.event === 'session_recovered') await recordSessionRecovered();
}

/**
 * Adds whether the reusing request came from the IP the session was issued to (`issuedIp`, set by
 * rotateSession). A match is the usual benign shape: a second client on the same network holding a
 * stale cookie. A mismatch is not proof of theft either - a session lives for weeks and IPs change -
 * but it is where triage should start.
 */
function withIssuedIpComparison(
  metadata: Record<string, unknown> | undefined,
  actorIp: string
): Record<string, unknown> | undefined {
  const issuedIp = metadata?.issuedIp;
  if (typeof issuedIp !== 'string' || actorIp === 'unknown') return metadata;
  return { ...metadata, requestIpMatchesIssuedIp: issuedIp === actorIp };
}
