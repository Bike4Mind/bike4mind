import z from 'zod';

export const GENERATED_ASSET_GENERATORS = ['music', 'video', 'image', 'speech', 'sound_effect'] as const;

export type GeneratedAssetGenerator = (typeof GENERATED_ASSET_GENERATORS)[number];

/**
 * What produced a generated file, stamped as `sourceMetadata.generation` on its FabFile. The notebook link
 * (`sessionId`, `questId`) stays at the top of `sourceMetadata`, where listBySession and the session-delete
 * cascade already read it.
 */
export const GeneratedAssetMetadataSchema = z.object({
  generator: z.enum(GENERATED_ASSET_GENERATORS),
  provider: z.string(),
  /** Absent when the provider chose its own default model and did not report it. */
  modelId: z.string().optional(),
  /** Set for job-backed generations; the save is idempotent per job. */
  jobId: z.string().optional(),
  prompt: z.string(),
  lyrics: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

export type GeneratedAssetMetadata = z.infer<typeof GeneratedAssetMetadataSchema>;

/**
 * Why a generated file was not kept in the user's files. Never fatal: the output was already produced and
 * billed, so it is still handed to the caller.
 */
export const generatedAssetSaveSkippedReasonSchema = z.enum(['storage_limit', 'file_too_large', 'error']);

export type GeneratedAssetSaveSkippedReason = z.infer<typeof generatedAssetSaveSkippedReasonSchema>;
