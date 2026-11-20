import {
  GeneratedAssetMetadataSchema,
  isGenerationJobOfKind,
  isStoredPromptPossiblyTruncated,
  type IGenerationJobDocument,
  type SpeechWordTiming,
} from '@bike4mind/common';

/**
 * What a generated voice clip says, for timing captions from it (Studio Productions). Read from the speech job
 * that made the file when it can be found: that holds the full script and the provider's word timings. Otherwise
 * the file's own stored prompt, which a long script may have been cut to (`truncated`).
 */
export type SpeechScript = {
  text: string;
  truncated: boolean;
  wordTimings?: SpeechWordTiming[];
  /** The clip's measured length, when the server could measure it (MP3). */
  durationMs?: number;
};

type SpeechScriptSource = { id: string; sourceMetadata?: Record<string, unknown> };

const toMs = (seconds: number | undefined) => (seconds === undefined ? undefined : Math.round(seconds * 1000));

/** Null when the file is not a generated speech clip. */
export async function loadSpeechScript(
  file: SpeechScriptSource,
  findJob: (jobId: string) => Promise<IGenerationJobDocument | null>
): Promise<SpeechScript | null> {
  const parsed = GeneratedAssetMetadataSchema.safeParse(file.sourceMetadata?.generation);
  if (!parsed.success || parsed.data.generator !== 'speech') return null;
  const generation = parsed.data;
  const job = generation.jobId ? await findJob(generation.jobId) : null;
  // The job must be the one that produced this file, so a stale or mismatched id never lends another job's text.
  if (job && isGenerationJobOfKind(job, 'speech') && job.payload.output?.fileId === file.id) {
    const { request, wordTimings, output } = job.payload;
    return {
      text: request.text,
      truncated: false,
      ...(wordTimings && wordTimings.length > 0 && { wordTimings }),
      ...(output.durationSeconds !== undefined && { durationMs: toMs(output.durationSeconds) }),
    };
  }
  return {
    text: generation.prompt,
    truncated: isStoredPromptPossiblyTruncated(generation),
    ...(generation.durationSeconds !== undefined && { durationMs: toMs(generation.durationSeconds) }),
  };
}
