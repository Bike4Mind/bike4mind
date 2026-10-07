import { z } from 'zod';

export const RELEASE_NOTES_SCHEMA_VERSION = 1;

export const ReleaseNoteCategorySchema = z.enum(['new', 'improved', 'fixed']);
export type ReleaseNoteCategory = z.infer<typeof ReleaseNoteCategorySchema>;

export const ReleaseNoteItemSchema = z.object({
  category: ReleaseNoteCategorySchema,
  text: z.string().min(1),
  // 1 = headline-worthy, 3 = minor
  importance: z.number().int().min(1).max(3),
  sourcePrs: z.array(z.number().int().positive()),
});
export type ReleaseNoteItem = z.infer<typeof ReleaseNoteItemSchema>;

export const ReleaseNoteStatusSchema = z.enum(['scheduled', 'hidden']);
export type ReleaseNoteStatus = z.infer<typeof ReleaseNoteStatusSchema>;

export const ReleaseNoteSchema = z.object({
  releaseTag: z.string().min(1),
  deployedSha: z.string().min(1),
  deployedAt: z.coerce.date(),
  headline: z.string(),
  summary: z.string(),
  items: z.array(ReleaseNoteItemSchema),
  audience: z.literal('public'),
  status: ReleaseNoteStatusSchema,
  // Not visible to readers before this instant (deployedAt + embargo).
  publishAt: z.coerce.date(),
  // Set by a human edit; a non-null value makes the note immune to regeneration.
  editedAt: z.coerce.date().nullable(),
  schemaVersion: z.number().int(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

export const ReleaseNotesJobPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(z.string()),
  customerNote: z.string().optional(),
  excerpt: z.string(),
});
export type ReleaseNotesJobPr = z.infer<typeof ReleaseNotesJobPrSchema>;

/** SQS body sent by the release workflow; consumed by the workers releaseNotes queue handler. */
export const ReleaseNotesJobPayloadSchema = z.object({
  kind: z.literal('release-notes'),
  schemaVersion: z.number().int(),
  releaseTag: z.string().min(1),
  releaseUrl: z.string(),
  previousTag: z.string().nullable(),
  deployedSha: z.string().min(1),
  deployedAt: z.coerce.date(),
  prs: z.array(ReleaseNotesJobPrSchema),
});
export type ReleaseNotesJobPayload = z.infer<typeof ReleaseNotesJobPayloadSchema>;

export const ReleaseNotesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  modelId: z.string().default('gpt-4o-mini'),
  embargoHours: z.number().min(0).max(168).default(12),
  // Case-insensitive terms that must never reach customer-facing copy.
  denylist: z.array(z.string()).default([]),
  slackTeamId: z.string().optional(),
  slackChannelId: z.string().optional(),
});
export type ReleaseNotesConfig = z.infer<typeof ReleaseNotesConfigSchema>;
