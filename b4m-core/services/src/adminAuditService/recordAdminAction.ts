import {
  ADMIN_AUDIT_CATALOGUE,
  type AdminAuditAction,
  type AdminAuditCatalogueEntry,
  type AdminAuditSeverity,
  type AuditActor,
  type AuditChange,
  type AuditEntry,
  type AuditTarget,
  type IAdminAuditLogRepository,
  type StoredAuditContext,
} from '@bike4mind/common';
import { redactAuditPayload, redactChange } from './redactAuditPayload';

export type RecordAdminActionInput = {
  action: AdminAuditAction;
  actor: AuditActor;
  target: AuditTarget;
  summary: string;
  context: StoredAuditContext;
  organizationId?: string;
  reason?: string;
  changes?: AuditChange[];
  details?: Record<string, unknown>;
  related?: AuditEntry['related'];
  occurredAt?: Date;
};

/** The admin-settings thresholds above which a credit grant is written as critical. */
export type CreditGrantPolicy = {
  singleGrantCredits: number;
  dailyTotalCredits: number;
  sumCreditsGranted: IAdminAuditLogRepository['sumCreditsGranted'];
};

export type RecordAdminActionAdapters = {
  db: { adminAuditLog: Pick<IAdminAuditLogRepository, 'append'> };
  /** Required for a grant on an action the catalogue marks `escalatesAboveGrantThreshold`. */
  creditGrantPolicy?: CreditGrantPolicy;
  logger?: { error: (message: string, meta?: Record<string, unknown>) => void };
};

const DAY_MS = 24 * 60 * 60_000;

type GrantThresholdExceeded = { kind: 'singleGrant' | 'dailyTotal'; limitCredits: number };

const findExceededGrantThreshold = async (
  input: RecordAdminActionInput,
  occurredAt: Date,
  policy: CreditGrantPolicy | undefined
): Promise<GrantThresholdExceeded | null> => {
  const credits = input.details?.credits;
  if (typeof credits !== 'number' || credits <= 0) return null;
  if (!policy)
    throw new Error(`recordAdminAction: ${input.action} needs a creditGrantPolicy to apply grant thresholds`);

  if (credits > policy.singleGrantCredits) return { kind: 'singleGrant', limitCredits: policy.singleGrantCredits };
  // A system or script actor has no userId to total by; only the single-grant line applies to it.
  if (!input.actor.userId) return null;
  const grantedToday = await policy.sumCreditsGranted(input.actor.userId, new Date(occurredAt.getTime() - DAY_MS));
  return grantedToday + credits > policy.dailyTotalCredits
    ? { kind: 'dailyTotal', limitCredits: policy.dailyTotalCredits }
    : null;
};

/**
 * Appends an admin audit entry. Category and severity come from the catalogue only, except that a
 * credit grant above a `creditGrantPolicy` threshold is escalated to critical and says which one in
 * `details.grantThresholdExceeded`. A `strict` action rethrows on failure so the caller's
 * transaction rolls back; a `bestEffort` action logs and returns null.
 */
export const recordAdminAction = async (
  input: RecordAdminActionInput,
  adapters: RecordAdminActionAdapters
): Promise<AuditEntry | null> => {
  const catalogued: AdminAuditCatalogueEntry = ADMIN_AUDIT_CATALOGUE[input.action];
  const { category, write } = catalogued;
  const organizationId = input.organizationId ?? (input.target.kind === 'organization' ? input.target.id : undefined);
  const occurredAt = input.occurredAt ?? new Date();

  try {
    const exceeded = catalogued.escalatesAboveGrantThreshold
      ? await findExceededGrantThreshold(input, occurredAt, adapters.creditGrantPolicy)
      : null;
    const severity: AdminAuditSeverity = exceeded ? 'critical' : catalogued.severity;
    const details = exceeded ? { ...input.details, grantThresholdExceeded: exceeded } : input.details;

    return await adapters.db.adminAuditLog.append({
      occurredAt,
      action: input.action,
      category,
      severity,
      actor: input.actor,
      target: input.target,
      organizationId,
      summary: input.summary,
      reason: input.reason,
      changes: input.changes?.map(redactChange),
      details: details ? redactAuditPayload(details) : undefined,
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
