import { z } from 'zod';
import { MAX_MUSIC_OUTPUT_BYTES, MUSIC_MODEL_CATALOG, type ValidatedMusicRequest } from '@bike4mind/common';
import { readJson } from '../../generationProviders/http';
import {
  classifyGeminiSubmitFailure,
  GEMINI_BASE_URL,
  GeminiErrorSchema,
  isGeminiSafetyError,
} from '../../videoProviders/gemini/geminiHttp';
import { mp3DurationSeconds } from '../mp3Duration';
import {
  ProviderSubmitError,
  readBoundedResponse,
  type ProviderContext,
  type ProviderOutput,
  type ProviderTerminalResult,
  type ResolvedInputs,
  type SyncGenerationProvider,
} from '../types';

// Wire shapes are pinned by __fixtures__ (see record.ts). Measured 2026-10-13: a blocking call returns a 2-minute
// song in about 30 s. Background mode (`background: true`) also works but its result carries no lyrics, so the
// adapter blocks and the music job stores the output in the same step.
const INTERACTIONS_URL = `${GEMINI_BASE_URL}/v1beta/interactions`;
const PREFIX = 'gemini_lyria';
const SAFETY_REASON = 'gemini_lyria_safety';
const NO_AUDIO_REASON = 'gemini_lyria_no_audio';
const DEFAULT_AUDIO_TYPE = 'audio/mpeg';
// Audio arrives as base64 inside the interaction JSON: about 4/3 of the audio, plus the lyrics.
const MAX_INTERACTION_BYTES = Math.ceil((MAX_MUSIC_OUTPUT_BYTES * 4) / 3) + 1024 * 1024;

const ContentSchema = z.looseObject({
  type: z.string(),
  data: z.string().optional(),
  mime_type: z.string().optional(),
  text: z.string().optional(),
});
const InteractionSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  steps: z.array(z.looseObject({ type: z.string(), content: z.array(ContentSchema).optional() })).optional(),
  error: GeminiErrorSchema.optional(),
  finish_reason: z.string().optional(),
});
type Interaction = z.infer<typeof InteractionSchema>;
type Content = z.infer<typeof ContentSchema>;

type LyriaProviderId = 'gemini-lyria';
type LyriaModelId = 'lyria-3.5' | 'lyria-3-clip-preview';

/**
 * Lyria has no length, vocals or lyrics parameter: all three travel in the prompt, as the docs prescribe. The
 * length hint is only sent to a prompt-steered model; the clip model always returns 30 s.
 */
export const buildLyriaInput = (request: ValidatedMusicRequest): string => {
  const parts = [request.prompt];
  if (MUSIC_MODEL_CATALOG[request.model].duration.control === 'approximate') {
    parts.push(`Make it about ${request.durationSeconds} seconds long.`);
  }
  if (request.instrumental) parts.push('Instrumental only, no vocals.');
  // Set apart from the musical direction, as the docs advise, so the lines are sung as written.
  if (request.lyrics) parts.push(`Lyrics:\n${request.lyrics}`);
  return parts.join('\n\n');
};

const modelOutputs = (interaction: Interaction): Content[] =>
  interaction.steps?.filter(step => step.type === 'model_output').flatMap(step => step.content ?? []) ?? [];

// Lyria marks sections as `[[A0]]` lines and sung lines with a `[:]` prefix; an instrumental reads `<instrumental>`.
const SECTION_MARKER = /^\[\[[A-Z]+\d+\]\]$/;
const LINE_MARKER = /^\[:\]\s?/;

export const normalizeLyriaLyrics = (raw: string): string | undefined => {
  const sections: string[][] = [[]];
  for (const line of raw.split('\n').map(text => text.trim())) {
    if (SECTION_MARKER.test(line)) {
      sections.push([]);
    } else if (line.length > 0 && line !== '<instrumental>') {
      sections[sections.length - 1].push(line.replace(LINE_MARKER, ''));
    }
  }
  const text = sections
    .filter(lines => lines.length > 0)
    .map(lines => lines.join('\n'))
    .join('\n\n');
  return text.length > 0 ? text : undefined;
};

const lyricsOf = (outputs: Content[]): string | undefined =>
  normalizeLyriaLyrics(
    outputs.flatMap(content => (content.type === 'text' && content.text ? [content.text] : [])).join('\n')
  );

const failed = (code: string, retryable: boolean, raw: unknown): ProviderTerminalResult => ({
  status: 'failed',
  retryable,
  message: `${PREFIX}_${code}`,
  raw,
});

const toSucceeded = (audio: Content & { data: string }, outputs: Content[]): ProviderTerminalResult => {
  const durationSeconds = mp3DurationSeconds(Buffer.from(audio.data, 'base64'));
  const lyrics = lyricsOf(outputs);
  return {
    status: 'succeeded',
    output: { kind: 'inline', base64: audio.data, contentType: audio.mime_type ?? DEFAULT_AUDIO_TYPE },
    ...(durationSeconds !== undefined && { reportedDurationSeconds: durationSeconds }),
    ...(lyrics !== undefined && { lyrics }),
  };
};

const toTerminal = (interaction: Interaction, ctx: ProviderContext): ProviderTerminalResult => {
  if (interaction.status === 'completed') {
    const outputs = modelOutputs(interaction);
    const audio = outputs.findLast(
      (content): content is Content & { data: string } => content.type === 'audio' && !!content.data
    );
    if (audio) return toSucceeded(audio, outputs);
    // Not observed live; a refusal that completes with text only must not bill the user for a song.
    ctx.logger.warn(`${PREFIX}_completed_without_audio`, { interactionId: interaction.id });
    return { status: 'blocked', reason: NO_AUDIO_REASON, raw: { id: interaction.id, steps: interaction.steps } };
  }
  if (isGeminiSafetyError(interaction.error, interaction.finish_reason)) {
    return { status: 'blocked', reason: SAFETY_REASON, raw: interaction };
  }
  // A blocking call only ends completed; anything else (failed, incomplete, ...) is a finished attempt that may
  // have billed, so it is not retried.
  return failed(interaction.status, false, interaction);
};

/** Google Lyria over the Gemini Interactions REST API, one blocking call per song. */
export class LyriaMusicProvider implements SyncGenerationProvider<
  LyriaProviderId,
  LyriaModelId,
  ValidatedMusicRequest
> {
  readonly mode = 'sync' as const;
  readonly id = 'gemini-lyria' as const;
  readonly models = ['lyria-3.5', 'lyria-3-clip-preview'] as const;

  async generate(
    request: ValidatedMusicRequest,
    _inputs: ResolvedInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    let response: Response;
    try {
      response = await fetch(INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify({ model: request.model, input: buildLyriaInput(request) }),
        signal: ctx.signal,
      });
    } catch (error) {
      // Unknown outcome: the song may have been generated and billed, so the job must not call again.
      throw new ProviderSubmitError(`${PREFIX}_transport`, false, String(error));
    }
    if (!response.ok) {
      const raw = await readJson(response);
      const failure = classifyGeminiSubmitFailure(response.status, raw, PREFIX);
      if (failure === 'blocked') return { status: 'blocked', reason: SAFETY_REASON, raw };
      // retryable is set only for a 408/429, which generated nothing; any other 4xx repeats and a 5xx may have billed.
      return { status: 'failed', retryable: failure.retryable, message: failure.message, raw };
    }
    const body = await readBoundedResponse(response, MAX_INTERACTION_BYTES);
    const parsed = InteractionSchema.safeParse(parseJson(body));
    // Answered and probably billed, but unreadable: a shape change to fix, not something a retry gets past.
    if (!parsed.success) return failed('unparseable', false, body.subarray(0, 2048).toString('utf8'));
    return toTerminal(parsed.data, ctx);
  }

  async fetchOutput(output: ProviderOutput): Promise<Buffer> {
    if (output.kind !== 'inline') throw new Error(`${PREFIX}_unexpected_url_output`);
    return Buffer.from(output.base64, 'base64');
  }
}

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
};
