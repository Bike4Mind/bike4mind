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

export const AuditContextSchema = z.object({
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  requestId: z.string().optional(),
  source: z.enum(['admin_ui', 'api_key', 'script', 'worker']),
  route: z.string().optional(),
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

export type NewAdminAuditEntry = Omit<AuditEntry, 'id' | 'source'>;

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
  findById(id: string): Promise<AuditEntry | null>;
  summarize(since: Date): Promise<Omit<AuditSummary, 'windowDays' | 'since'>>;
}
