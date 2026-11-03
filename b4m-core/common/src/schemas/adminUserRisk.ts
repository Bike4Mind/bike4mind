import * as z from 'zod';
import { USER_TIMELINE_TYPES } from '../types/entities/adminUserTimeline';

/**
 * Contract for GET /api/admin/users/[userId]/risk-flags: named, rule-based flags with the raw
 * evidence behind each. Deliberately has no composite score; each flag stands on its own rule.
 */
export const ADMIN_USER_RISK_FLAG_IDS = [
  'failed_sign_ins',
  'new_ip_or_device',
  'credit_spike',
  'prior_moderation',
] as const;
export type AdminUserRiskFlagId = (typeof ADMIN_USER_RISK_FLAG_IDS)[number];

export const ADMIN_USER_RISK_SEVERITIES = ['info', 'warn', 'high'] as const;
export type AdminUserRiskSeverity = (typeof ADMIN_USER_RISK_SEVERITIES)[number];

export const adminUserRiskFlagSchema = z.object({
  id: z.enum(ADMIN_USER_RISK_FLAG_IDS),
  severity: z.enum(ADMIN_USER_RISK_SEVERITIES),
  /** Plain-language statement of the rule that fired, including its thresholds. */
  rule: z.string(),
  evidence: z.array(z.object({ label: z.string(), value: z.string() })),
  window: z.object({ from: z.string(), to: z.string() }),
  /** Activity timeline filter that shows the underlying events, when the timeline covers them. */
  timeline: z
    .object({
      types: z.array(z.enum(USER_TIMELINE_TYPES)),
      from: z.string(),
      to: z.string(),
    })
    .optional(),
});

export const adminUserRiskFlagsSchema = z.object({ flags: z.array(adminUserRiskFlagSchema) });

export type AdminUserRiskFlag = z.infer<typeof adminUserRiskFlagSchema>;
export type AdminUserRiskFlags = z.infer<typeof adminUserRiskFlagsSchema>;
