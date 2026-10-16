import z from 'zod';

export const GENERATED_ASSET_GENERATORS = ['music', 'video', 'image', 'speech', 'sound_effect'] as const;

export type GeneratedAssetGenerator = (typeof GENERATED_ASSET_GENERATORS)[number];

/**
 * Tag the generated-file writers apply (saveGeneratedAsset always, persistGeneratedFile unless its caller passes its
 * own tags); the Files "Generated" filter matches on it.
 */
export const GENERATED_ASSET_TAG = 'generated';

/**
 * The second tag saveGeneratedAsset applies, naming the generator; it also labels the file name. Hyphenated like the
 * other user-facing tags. Studio's recent-generations lists filter on it.
 */
export const GENERATED_ASSET_GENERATOR_TAG: Record<GeneratedAssetGenerator, string> = {
  music: 'music',
  speech: 'speech',
  sound_effect: 'sound-effect',
  video: 'video',
  image: 'image',
};

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
  /**
   * Storing caps `prompt` at a prefix of what was generated (sourceMetadata rides every metadata-only
   * listing). Set when that happened, so a surface that lets the user reuse the text can tell it is
   * incomplete rather than silently generating from half a script.
   */
  promptTruncated: z.boolean().optional(),
  lyrics: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  // The audio settings the caller picked, so Studio's "use these settings again" can restore them.
  /** Speech: the requested voice; absent when the provider default was used or another provider stood in. */
  voice: z.string().optional(),
  /** Speech: the output format. */
  format: z.string().optional(),
  /** Speech: the requested language; absent when the provider auto-detected it. */
  languageCode: z.string().optional(),
  /** Sound effects: how closely the provider followed the prompt, 0-1. */
  promptInfluence: z.number().min(0).max(1).optional(),
});

export type GeneratedAssetMetadata = z.infer<typeof GeneratedAssetMetadataSchema>;

/** sourceMetadata rides every metadata-only file listing, so a long TTS script or lyric sheet is stored as a prefix. */
export const GENERATED_ASSET_MAX_STORED_TEXT_CHARS = 2_000;

/**
 * Whether the stored prompt may be only a prefix of what was generated. Files saved before `promptTruncated`
 * existed were cut at the same cap without the flag, so a cap-length prompt with no flag counts as cut too.
 */
export function isStoredPromptPossiblyTruncated(
  generation: Pick<GeneratedAssetMetadata, 'prompt' | 'promptTruncated'>
) {
  return generation.promptTruncated ?? generation.prompt.length >= GENERATED_ASSET_MAX_STORED_TEXT_CHARS;
}

/**
 * The generated-content bucket key of the second copy an in-chat tool keeps for inline playback
 * (`quest.images`), stamped as `sourceMetadata.generatedCopyKey` so deleting the file can remove that copy too.
 */
export function generatedCopyKeyOf(file: { sourceMetadata?: Record<string, unknown> }): string | undefined {
  const key = file.sourceMetadata?.generatedCopyKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * Why a generated file was not kept in the user's files. Never fatal: the output was already produced and
 * billed, so it is still handed to the caller.
 */
export const generatedAssetSaveSkippedReasonSchema = z.enum(['storage_limit', 'file_too_large', 'error']);

export type GeneratedAssetSaveSkippedReason = z.infer<typeof generatedAssetSaveSkippedReasonSchema>;
