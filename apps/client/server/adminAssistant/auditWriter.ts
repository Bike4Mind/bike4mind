import { ADMIN_AUDIT_CREDIT_GRANT_ACTIONS, type AdminAssistantToolName } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { loadCreditGrantPolicy, toUserActor, type AdminAuditWriter } from '@bike4mind/server-utils/utils/adminAudit';
import type { ToolContext } from '@bike4mind/services/llm/tools';

/**
 * The AdminAuditLog writer for an admin assistant tool. A tool call has no request, so the actor is
 * the chat's user from the tool context (defineAdminTool has already checked it is an admin) and the
 * route names the tool. Nothing is caught here: a strict action's failed write throws, and
 * defineAdminTool turns that into a failed tool call, so the content is never returned unaudited.
 */
export const adminAssistantAuditWriter =
  (context: Pick<ToolContext, 'user' | 'logger'>, toolName: AdminAssistantToolName): AdminAuditWriter =>
  async ({ actorScope, ...input }, options = {}) =>
    adminAuditService.recordAdminAction(
      {
        ...input,
        actor: toUserActor(context.user, actorScope ?? 'platform'),
        context: { source: 'admin_ui', route: `admin-assistant/${toolName}` },
      },
      {
        db: { adminAuditLog: adminAuditLogRepository },
        creditGrantPolicy: ADMIN_AUDIT_CREDIT_GRANT_ACTIONS.includes(input.action)
          ? await (options.creditGrantPolicy ?? loadCreditGrantPolicy)()
          : undefined,
        logger: context.logger,
      }
    );
