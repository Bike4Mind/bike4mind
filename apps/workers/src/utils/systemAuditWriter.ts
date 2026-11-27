import { ADMIN_AUDIT_CREDIT_GRANT_ACTIONS } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import {
  loadCreditGrantPolicy,
  systemAuditActor,
  type AdminAuditWriter,
} from '@bike4mind/server-utils/utils/adminAudit';

/**
 * The writer for a job acting on its own authority: a system actor named `name`, and `route` as the
 * context. Kept apart from adminAudit.ts, whose request-only shape adminAudit.typecheck.test.ts pins.
 */
export const systemAuditWriter =
  (name: string, route: string, logger?: adminAuditService.RecordAdminActionAdapters['logger']): AdminAuditWriter =>
  async ({ actorScope: _actorScope, ...input }, options = {}) =>
    adminAuditService.recordAdminAction(
      { ...input, actor: systemAuditActor(name), context: { source: 'worker', route } },
      {
        db: { adminAuditLog: adminAuditLogRepository },
        creditGrantPolicy: ADMIN_AUDIT_CREDIT_GRANT_ACTIONS.includes(input.action)
          ? await (options.creditGrantPolicy ?? loadCreditGrantPolicy)()
          : undefined,
        logger,
      }
    );
