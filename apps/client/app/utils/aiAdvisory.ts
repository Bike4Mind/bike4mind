import { SHADOW_DETECTORS } from '@bike4mind/common';
import { z } from 'zod';

/** How far back the advisory looks for unreviewed detections the AI judged as abuse. */
export const AI_ADVISORY_WINDOW_HOURS = 24;

/** The only AI verdict the Users list filters on; the advisory surfaces nothing else. */
export const USER_AI_VERDICT_FILTERS = ['abuse'] as const;

/** One account the AI judged as abuse, from the strongest of its unreviewed detections. */
export const aiAbuseAdvisorySchema = z.object({
  userId: z.string(),
  detectionId: z.string(),
  detector: z.enum(SHADOW_DETECTORS),
  /** The model's probability for `abuse`; null when the assessment carried no probabilities. */
  abuseProbability: z.number().min(0).max(1).nullable(),
  assessedAt: z.date(),
});
export type AiAbuseAdvisory = z.infer<typeof aiAbuseAdvisorySchema>;

/**
 * A signup IP behind two or more flagged accounts, or one a detector would block: a candidate for the
 * Blocked IPs list, never blocked automatically.
 */
export const aiAdvisoryNetworkSchema = z.object({
  ip: z.string(),
  country: z.string().nullable(),
  asnOrg: z.string().nullable(),
  hosting: z.boolean().nullable(),
  accountCount: z.number().int().min(1),
  /** True when a detector on this IP would itself have blocked it. */
  detectorWouldBlock: z.boolean(),
});
export type AiAdvisoryNetwork = z.infer<typeof aiAdvisoryNetworkSchema>;

/** A mail domain two or more flagged accounts share in a campaign (personal mailbox providers never count). */
export const aiAdvisoryMailDomainSchema = z.object({
  domain: z.string(),
  accountCount: z.number().int().min(1),
});
export type AiAdvisoryMailDomain = z.infer<typeof aiAdvisoryMailDomainSchema>;

export const aiAdvisorySummarySchema = z.object({
  since: z.date(),
  /** Accounts, strongest abuse probability first. Already-suspended accounts are left out. */
  advisories: z.array(aiAbuseAdvisorySchema),
  networks: z.array(aiAdvisoryNetworkSchema),
  mailDomains: z.array(aiAdvisoryMailDomainSchema),
  /** True when the scan hit its cap, so there may be more than `advisories` holds. */
  truncated: z.boolean(),
});
export type AiAdvisorySummary = z.infer<typeof aiAdvisorySummarySchema>;
