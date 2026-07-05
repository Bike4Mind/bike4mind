import { z } from 'zod';

/**
 * ImageModerationIncident - audit record for a generated image blocked by
 * auto-moderation. Metadata-only (no image bytes); byte preservation for
 * Section 2258A retention is a later quest.
 */

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
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export type ImageModerationIncident = z.infer<typeof ImageModerationIncidentSchema>;
