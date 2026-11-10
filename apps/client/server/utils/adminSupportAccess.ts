import { z } from 'zod';
import type { Request } from 'express';
import { AdminSupportAccessAction, ISessionDocument } from '@bike4mind/common';
import { adminSupportAccessAuditLogRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { requireAdminPermission } from '@server/middlewares/adminApi';
import { SUPPORT_CASE_MAX_LENGTH, SUPPORT_CASE_MIN_LENGTH } from '@client/shared/supportCase';

/**
 * Shared gate for admin support READS of customer content: the notebook view
 * (`/api/admin/sessions/...`) and the model-log detail and prompt search
 * (`/api/admin/model-logs...`).
 *
 * These are admin reads of customer content with a MANDATORY reason code and a
 * blocking audit write, so the rules live in one place:
 *
 * - full admins and `support:read` delegates only;
 * - a `supportCase` reference is required, so the audit log says *why* the read
 *   happened without needing a second system to cross-reference;
 * - every read is recorded, and the audit write is awaited before the content is
 *   returned - if it fails, the request fails. The trail is the feature.
 *
 * Admin reads of feedback text are audited too, but in AdminAuditLog with no
 * case (`feedback.viewed`): feedback is written to staff, and triage reads it
 * routinely. Admin reads of lake content through the `assertLakeAccess` admin
 * arm are not covered here yet; that is separate, tracked work.
 *
 * Read-only by construction: nothing here grants an admin write path. Support
 * remediation needs a separate, consent-aware mechanism (see the sibling issue).
 *
 * Gated on the `support:read` admin permission, the same one the routes declare
 * through `adminApi`; checked here too so this helper stays a gate on its own.
 * (`User.role` and `InternalTeamMember.role` are NOT authz sources - neither is
 * read by any access check.)
 *
 * Scope note: only SUCCESSFUL reads are recorded. Every rejection path below
 * throws before `recordSupportRead` is reachable, so the trail answers "who read
 * this notebook?" but not "who tried?". That is deliberate - a rejected request
 * disclosed nothing - but it means enumeration attempts leave no trace here.
 */

export const SupportCaseSchema = z.string().trim().min(SUPPORT_CASE_MIN_LENGTH).max(SUPPORT_CASE_MAX_LENGTH);

/** Query params every session support read endpoint accepts. */
export const SupportReadQuerySchema = z.object({
  id: z.string().min(1),
  supportCase: SupportCaseSchema,
});

/** Who is reading and under which case - everything the audit row needs except what was read. */
export interface SupportActorContext {
  supportCase: string;
  actorUserId: string;
  actorIp?: string;
  actorUserAgent?: string;
  actorApiKeyId?: string;
}

export interface SupportReadContext extends SupportActorContext {
  session: ISessionDocument;
}

/** What a support read touched: the content owner and, when the read is scoped to one, the session. */
export interface SupportReadScope {
  targetUserId?: string;
  sessionId?: string;
}

interface SupportReadRequest {
  query: unknown;
  user?: { id: string; isAdmin?: boolean | null; adminPermissions?: readonly string[] | null };
  headers?: Record<string, string | string[] | undefined>;
  apiKeyInfo?: { keyId: string; scopes: readonly string[] };
}

function assertSupportReader(req: SupportReadRequest): asserts req is SupportReadRequest & { user: { id: string } } {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }
  requireAdminPermission(req, 'support:read');
}

function toActorContext(req: SupportReadRequest & { user: { id: string } }, supportCase: string): SupportActorContext {
  const userAgent = req.headers?.['user-agent'];
  return {
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
 * Authorize a support read that is not scoped to one notebook: the caller must hold
 * `support:read` and name a `supportCase`. Throws before any customer content is touched.
 */
export function authorizeSupportCase(req: SupportReadRequest, supportCase: unknown): SupportActorContext {
  assertSupportReader(req);
  return toActorContext(req, SupportCaseSchema.parse(supportCase));
}

/**
 * Authorize a support read and load the target session. Throws before any
 * customer content is touched; 404s an unknown session rather than 403ing, so an
 * under-privileged caller can't enumerate ids.
 */
export async function authorizeSupportRead(req: SupportReadRequest): Promise<SupportReadContext> {
  assertSupportReader(req);
  const { id, supportCase } = SupportReadQuerySchema.parse(req.query);

  // An id that isn't an ObjectId names no session, so answer for it here rather than relying on
  // the lookup layer's own screen - this route's 404 is the documented answer.
  if (!isValidObjectId(id)) {
    throw new NotFoundError('Session not found');
  }

  const session = await sessionRepository.findById(id);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  // An account in its deletion grace period is out of reach of support browsing.
  const owner = await userRepository.findById(session.userId);
  if (owner?.deletion) {
    throw new ForbiddenError('This account is scheduled for deletion');
  }

  return { ...toActorContext(req, supportCase), session };
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
  await recordSupportAccess(ctx, action, { targetUserId: ctx.session.userId, sessionId: ctx.session.id }, details);
}

/** Record a support read of any scope. Same contract as {@link recordSupportRead}: await it before responding. */
export async function recordSupportAccess(
  ctx: SupportActorContext,
  action: AdminSupportAccessAction,
  scope: SupportReadScope,
  details?: Record<string, unknown>
): Promise<void> {
  await adminSupportAccessAuditLogRepository.record({
    action,
    actorUserId: ctx.actorUserId,
    targetUserId: scope.targetUserId,
    sessionId: scope.sessionId,
    supportCase: ctx.supportCase,
    actorIp: ctx.actorIp,
    actorUserAgent: ctx.actorUserAgent,
    actorApiKeyId: ctx.actorApiKeyId,
    details,
  });
}
