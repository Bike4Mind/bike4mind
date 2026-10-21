import {
  ADMIN_AUDIT_CATALOGUE,
  type AdminAuditAction,
  type AuditActor,
  type AuditChange,
  type AuditContext,
  type AuditEntry,
  type AuditTarget,
  type IAdminAuditLogRepository,
} from '@bike4mind/common';
import { redactAuditPayload, redactChange } from './redactAuditPayload';

export type RecordAdminActionInput = {
  action: AdminAuditAction;
  actor: AuditActor;
  target: AuditTarget;
  summary: string;
  context: AuditContext;
  organizationId?: string;
  reason?: string;
  changes?: AuditChange[];
  details?: Record<string, unknown>;
  related?: AuditEntry['related'];
  occurredAt?: Date;
};

export type RecordAdminActionAdapters = {
  db: { adminAuditLog: Pick<IAdminAuditLogRepository, 'append'> };
  logger?: { error: (message: string, meta?: Record<string, unknown>) => void };
};

/**
 * Appends an admin audit entry. Category and severity come from the catalogue only.
 * A `strict` action rethrows on failure so the caller's transaction rolls back; a
 * `bestEffort` action logs and returns null.
 */
export const recordAdminAction = async (
  input: RecordAdminActionInput,
  adapters: RecordAdminActionAdapters
): Promise<AuditEntry | null> => {
  const { category, severity, write } = ADMIN_AUDIT_CATALOGUE[input.action];
  const organizationId = input.organizationId ?? (input.target.kind === 'organization' ? input.target.id : undefined);

  try {
    return await adapters.db.adminAuditLog.append({
      occurredAt: input.occurredAt ?? new Date(),
      action: input.action,
      category,
      severity,
      actor: input.actor,
      target: input.target,
      organizationId,
      summary: input.summary,
      reason: input.reason,
      changes: input.changes?.map(redactChange),
      details: input.details ? redactAuditPayload(input.details) : undefined,
      context: input.context,
      related: input.related,
    });
  } catch (error) {
    if (write === 'strict') throw error;
    const meta = { action: input.action, error };
    if (adapters.logger) adapters.logger.error('[ADMIN_AUDIT_WRITE_FAILED]', meta);
    else console.error('[ADMIN_AUDIT_WRITE_FAILED]', meta);
    return null;
  }
};
