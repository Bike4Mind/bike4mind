import { z } from 'zod';
import type { AdminAuditCategory, AdminAuditSeverity } from './adminAuditCatalogue';
import type { AuditLogCursor, AuditLogFilters, AuditSummary } from './adminAuditQuery';

export const AuditActorSchema = z.object({
  kind: z.enum(['user', 'apiKey', 'system', 'script']),
  scope: z.enum(['platform', 'organization']),
  userId: z.string().optional(),
  apiKeyId: z.string().optional(),
  email: z.string().optional(),
  name: z.string(),
  wasAdmin: z.boolean(),
  impersonatedUserId: z.string().optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditTargetSchema = z.object({
  kind: z.enum(['user', 'organization', 'settings', 'oauthClient', 'apiKey', 'system']),
  id: z.string(),
  displayName: z.string(),
});
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

export const AuditChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export type AuditChange = z.infer<typeof AuditChangeSchema>;

/** Sources a stored AdminAuditLog row can carry; the write input and the filters stay inside this set. */
export const StoredAuditContextSourceSchema = z.enum(['admin_ui', 'api_key', 'script', 'worker']);

export const StoredAuditContextSchema = z.object({
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  requestId: z.string().optional(),
  source: StoredAuditContextSourceSchema,
  route: z.string().optional(),
});
export type StoredAuditContext = z.infer<typeof StoredAuditContextSchema>;

/** Read-side context: 'user' is the account holder's own session, which only the security-store adapters emit. */
export const AuditContextSchema = StoredAuditContextSchema.extend({
  source: z.union([StoredAuditContextSourceSchema, z.literal('user')]),
});
export type AuditContext = z.infer<typeof AuditContextSchema>;

export const AdminAuditCategorySchema = z.enum([
  'credits',
  'access',
  'identity',
  'account',
  'org',
  'settings',
  'support',
]) satisfies z.ZodType<AdminAuditCategory>;

export const AdminAuditSeveritySchema = z.enum(['info', 'notice', 'critical']) satisfies z.ZodType<AdminAuditSeverity>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  source: z.enum(['admin', 'auth', 'apiKey', 'supportAccess']),
  occurredAt: z.date(),
  action: z.string(),
  category: AdminAuditCategorySchema,
  severity: AdminAuditSeveritySchema,
  actor: AuditActorSchema,
  target: AuditTargetSchema,
  organizationId: z.string().optional(),
  summary: z.string(),
  reason: z.string().optional(),
  changes: z.array(AuditChangeSchema).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  context: AuditContextSchema,
  related: z
    .object({
      creditTransactionId: z.string().optional(),
      impersonationSessionId: z.string().optional(),
    })
    .optional(),
  backfilled: z.boolean().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export type NewAdminAuditEntry = Omit<AuditEntry, 'id' | 'source' | 'context'> & { context: StoredAuditContext };

/** Deliberately not an IBaseRepository: an immutable log exposes no update or delete. */
export interface IAdminAuditLogRepository {
  append(entry: NewAdminAuditEntry): Promise<AuditEntry>;
  appendBackfill(
    entries: Array<NewAdminAuditEntry & { id: string }>
  ): Promise<{ inserted: number; duplicates: number }>;
  list(
    filters: AuditLogFilters,
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }>;
  /**
   * Entries about one subscription, newest first. `subscriptionIds` must hold every id the entries may name:
   * the Stripe-style `subscriptionId` and the Mongo `_id` string (org revoke writes the latter).
   */
  listForSubscription(
    scope: { owner: { kind: 'user' | 'organization'; id: string }; subscriptionIds: string[] },
    page: { limit: number; cursor?: AuditLogCursor }
  ): Promise<{ entries: AuditEntry[]; nextCursor: AuditLogCursor | null }>;
  findById(id: string): Promise<AuditEntry | null>;
  summarize(since: Date): Promise<Omit<AuditSummary, 'windowDays' | 'since'>>;
  /** Oldest first: entries strictly after `after` (or from the start) up to and including `until`. */
  listAscending(page: { after: AuditLogCursor | null; until: Date; limit: number }): Promise<AuditEntry[]>;
  /** Grants (positive `details.credits` on a grant action) by one actor with occurredAt in (from, to]. */
  countCreditGrants(actorUserId: string, window: { from: Date; to: Date }): Promise<number>;
  /** Total credits one actor granted with occurredAt at or after `since`. */
  sumCreditsGranted(actorUserId: string, since: Date): Promise<number>;
}

/** An actor whose credit-grant burst has already alerted; it stays open while grants keep coming. */
export type AdminAuditOpenBurst = { actorUserId: string; lastGrantAt: Date };

/**
 * The alert worker's progress through the audit log. Kept in its own collection because the log
 * itself is append-only: nothing may mark an entry as alerted.
 */
export type AdminAuditAlertState = {
  cursor: AuditLogCursor;
  openBursts: AdminAuditOpenBurst[];
  updatedAt?: Date;
};

export interface IAdminAuditAlertStateRepository {
  get(): Promise<AdminAuditAlertState | null>;
  save(state: Omit<AdminAuditAlertState, 'updatedAt'>): Promise<void>;
}

/** GET /api/admin/audit-log/alert-status: whether alerts are on, and the grant lines that make an entry critical. */
export type AuditAlertStatus = {
  alertsEnabled: boolean;
  singleGrantCredits: number;
  dailyGrantCredits: number;
};
