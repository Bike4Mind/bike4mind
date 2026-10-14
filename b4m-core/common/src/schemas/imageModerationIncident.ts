import { z } from 'zod';

/**
 * ImageModerationIncident - audit record for a generated image blocked by
 * auto-moderation. Metadata-only (no image bytes). S3 objects are preserved
 * by convention for 18 U.S.C. section 2258A; confirmed incidents must be reported
 * to NCMEC via the admin triage flow.
 */

export const INCIDENT_REVIEW_STATUSES = ['pending_review', 'confirmed_csam', 'false_positive', 'reported'] as const;
export type IncidentReviewStatus = (typeof INCIDENT_REVIEW_STATUSES)[number];

export const ModerationLabelHitSchema = z.object({
  name: z.string(),
  parentName: z.string(),
  confidence: z.number(),
});

export type ModerationLabelHit = z.infer<typeof ModerationLabelHitSchema>;

export const ImageModerationIncidentSchema = z.object({
  userId: z.string(),
  // Optional: agent-tool callers (image_generation/edit_image tools) have no questId, and
  // some tool harnesses build a ToolContext with no sessionId either (closing the
  // agent-tool moderation bypass). Queue-handler callers (ImageGeneration/ImageEdit services)
  // still always pass both.
  sessionId: z.string().optional(),
  questId: z.string().optional(),
  /** Uploaded-image incidents reference the FabFile instead of a quest/session. */
  fabFileId: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  labels: z.array(ModerationLabelHitSchema),
  // Triage state for the admin review queue. Absent on incidents created before Q3; treated
  // as 'pending_review' by all queries. Set to 'reported' once an NCMEC report is submitted.
  reviewStatus: z.enum(INCIDENT_REVIEW_STATUSES).optional(),
  // Populated when reviewStatus transitions to 'reported'. The CyberTipline report identifier
  // returned by NCMEC; retained as the audit trail that reporting occurred.
  ncmecReportId: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export type ImageModerationIncident = z.infer<typeof ImageModerationIncidentSchema>;
