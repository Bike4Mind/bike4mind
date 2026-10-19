import { z } from 'zod';
import type { AdminAuditAction } from './adminAuditCatalogue';
import {
  AdminAuditCategorySchema,
  AdminAuditSeveritySchema,
  AuditActorSchema,
  AuditContextSchema,
  AuditTargetSchema,
  type AuditEntry,
} from './AdminAuditLogTypes';

export const AUDIT_SUMMARY_WINDOWS = [7, 30, 90] as const;
export type AuditSummaryWindow = (typeof AUDIT_SUMMARY_WINDOWS)[number];

export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** The export route's JSON: the CSV is staged in storage and fetched from `url`, a short-lived signed GET. */
export type AuditExportResult = { url: string; rowCount: number; truncated: boolean; fileName: string };

// Catalogue keys so the summary facets and the filter schema stay type-checked against the actions.
export const IMPERSONATION_STARTED_ACTION: AdminAuditAction = 'user.impersonation.started';
export const IMPERSONATION_ENDED_ACTION: AdminAuditAction = 'user.impersonation.ended';

/** Both the API query (minus cursor/limit) and the page's URL search state. */
export const AuditLogFiltersSchema = z.object({
  category: AdminAuditCategorySchema.optional(),
  severity: AdminAuditSeveritySchema.optional(),
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+)+$/)
    .optional(),
  verb: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
  actorUserId: z.string().min(1).optional(),
  targetKind: AuditTargetSchema.shape.kind.optional(),
  targetId: z.string().min(1).optional(),
  source: AuditContextSchema.shape.source.optional(),
  actorScope: AuditActorSchema.shape.scope.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  requestId: z.string().min(1).optional(),
  impersonationSessionId: z.string().min(1).optional(),
});
export type AuditLogFilters = z.infer<typeof AuditLogFiltersSchema>;

export type AuditLogCursor = { occurredAt: Date; id: string };

export type AuditLogPage = { entries: AuditEntry[]; nextCursor: string | null };

export type AuditSummary = {
  windowDays: AuditSummaryWindow;
  since: string;
  creditGrants: { count: number; topGranters: Array<{ userId: string | null; name: string; count: number }> };
  /** Category 'access', excluding impersonation actions. */
  permissionChanges: number;
  impersonations: number;
  deletions: number;
  deniedAttempts: number;
};
