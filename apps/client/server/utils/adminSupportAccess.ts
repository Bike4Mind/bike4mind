import { Types } from 'mongoose';
import { z } from 'zod';
import type { Request } from 'express';
import { AdminSupportAccessAction, ISessionDocument } from '@bike4mind/common';
import { adminSupportAccessAuditLogRepository, sessionRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { getClientIp } from '@server/utils/ip';

/**
 * Shared gate for the admin support READ endpoints (`/api/admin/sessions/...`).
 *
 * These are the first admin reads of customer content with a MANDATORY reason
 * code and a blocking audit write, so the rules live in one place:
 *
 * - platform admin only;
 * - a `supportCase` reference is required, so the audit log says *why* the read
 *   happened without needing a second system to cross-reference;
 * - every read is recorded, and the audit write is awaited before the content is
 *   returned - if it fails, the request fails. The trail is the feature.
 *
 * They are NOT the only admin paths that reach customer content without the
 * sharing checks in `findAccessibleById` - `/api/admin/model-logs` spreads
 * `quest.promptMeta` (which carries the user's own prompt text, attached-file
 * names, and raw tool arguments) cross-user, unaudited and with no case
 * reference. Do not read this helper as a chokepoint that makes such routes
 * safe; hardening them is separate, tracked work.
 *
 * Read-only by construction: nothing here grants an admin write path. Support
 * remediation needs a separate, consent-aware mechanism (see the sibling issue).
 *
 * Gated on `isAdmin` rather than a narrower support role. If that is tightened
 * later, follow the existing tag-plus-predicate primitive rather than inventing
 * one: `canAccessTavern` / `hasTavernUserTag` in `@bike4mind/common` is a single
 * predicate consumed by BOTH the client guard and the server guards so the two
 * cannot drift (`hasDeveloperUserTag` is a second instance). A
 * `canPerformSupportRead` predicate would drop straight into the check below.
 * (`User.role` and `InternalTeamMember.role` are NOT authz sources - neither is
 * read by any access check.)
 *
 * Scope note: only SUCCESSFUL reads are recorded. Every rejection path below
 * throws before `recordSupportRead` is reachable, so the trail answers "who read
 * this notebook?" but not "who tried?". That is deliberate - a rejected request
 * disclosed nothing - but it means enumeration attempts leave no trace here.
 */

/** Query params every support read endpoint accepts. */
export const SupportReadQuerySchema = z.object({
  id: z.string().min(1),
  supportCase: z.string().trim().min(3).max(200),
});

export interface SupportReadContext {
  session: ISessionDocument;
  supportCase: string;
  actorUserId: string;
  actorIp?: string;
  actorUserAgent?: string;
  actorApiKeyId?: string;
}

interface SupportReadRequest {
  query: unknown;
  user?: { id: string; isAdmin?: boolean };
  headers?: Record<string, string | string[] | undefined>;
  apiKeyInfo?: { keyId: string };
}

/**
 * Authorize a support read and load the target session. Throws before any
 * customer content is touched; 404s an unknown session rather than 403ing, so an
 * under-privileged caller can't enumerate ids.
 */
export async function authorizeSupportRead(req: SupportReadRequest): Promise<SupportReadContext> {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }
  if (!req.user.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { id, supportCase } = SupportReadQuerySchema.parse(req.query);

  // An id that isn't an ObjectId would make findById throw a CastError (500);
  // treat it as "no such session" instead.
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError('Session not found');
  }

  const session = await sessionRepository.findById(id);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const userAgent = req.headers?.['user-agent'];

  return {
    session,
    supportCase,
    actorUserId: req.user.id,
    // The canonical resolver: it prefers the headers a CDN overwrites over raw
    // X-Forwarded-For, so a caller cannot choose the IP that lands in a two-year
    // compliance record. Same helper the auth audit log uses.
    actorIp: getClientIp(req as unknown as Request),
    actorUserAgent: typeof userAgent === 'string' ? userAgent : undefined,
    actorApiKeyId: req.apiKeyInfo?.keyId,
  };
}

/**
 * Record the read. Awaited by the caller before responding - a support read that
 * can't be audited must not be served.
 */
export async function recordSupportRead(
  ctx: SupportReadContext,
  action: AdminSupportAccessAction,
  details?: Record<string, unknown>
): Promise<void> {
  await adminSupportAccessAuditLogRepository.record({
    action,
    actorUserId: ctx.actorUserId,
    targetUserId: ctx.session.userId,
    sessionId: ctx.session.id,
    supportCase: ctx.supportCase,
    actorIp: ctx.actorIp,
    actorUserAgent: ctx.actorUserAgent,
    actorApiKeyId: ctx.actorApiKeyId,
    details,
  });
}
