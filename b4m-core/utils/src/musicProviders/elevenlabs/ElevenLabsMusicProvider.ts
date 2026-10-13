import { z } from 'zod';
import { MAX_MUSIC_OUTPUT_BYTES, type ValidatedMusicRequest } from '@bike4mind/common';
import { readJson } from '../../generationProviders/http';
import { mp3DurationSeconds } from '../mp3Duration';
import {
  ProviderOutputTooLargeError,
  ProviderSubmitError,
  readBoundedResponse,
  type ProviderContext,
  type ProviderOutput,
  type ProviderTerminalResult,
  type ResolvedInputs,
  type SyncGenerationProvider,
} from '../types';

// Wire shapes are pinned by __fixtures__ (see record.ts). Measured 2026-10-13: the call blocks until the song is
// ready (about 5 s for 10-15 s of audio) and answers multipart/mixed: the JSON metadata part, then the MP3 part.
const MUSIC_URL = 'https://api.elevenlabs.io/v1/music/detailed?output_format=mp3_44100_128';
const PREFIX = 'elevenlabs_music';
const COPYRIGHT_REASON = 'elevenlabs_music_copyright';
const NO_AUDIO_REASON = 'elevenlabs_music_no_audio';
const MP3_CONTENT_TYPE = 'audio/mpeg';
const MAX_RESPONSE_BYTES = MAX_MUSIC_OUTPUT_BYTES + 1024 * 1024;
// Both statuses arrive on a 400 refused before generation, so nothing was billed.
const REFUSAL_STATUSES = new Set(['bad_prompt', 'bad_composition_plan']);

const MIN_CHUNK_MS = 3000;
const MAX_CHUNK_MS = 120_000;
const MAX_CHUNKS = 30;
const MAX_V1_SECTION_LINES = 30;
const MAX_V1_SECTION_NAME_CHARS = 100;
const UNTAGGED_SECTION = 'Verse';

type ElevenLabsProviderId = 'elevenlabs';
const ELEVENLABS_MODELS = ['music_v2_5', 'music_v2', 'music_v1'] as const;
type ElevenLabsModelId = (typeof ELEVENLABS_MODELS)[number];
const isElevenLabsModel = (model: string): model is ElevenLabsModelId =>
  (ELEVENLABS_MODELS as readonly string[]).includes(model);

type Section = { name: string; lines: string[] };
type TimedSection = Section & { durationMs: number };

type ChunkPlan = {
  chunks: Array<{ text: string; duration_ms: number; positive_styles: string[]; negative_styles: string[] }>;
};
type SectionPlan = {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: Array<{
    section_name: string;
    positive_local_styles: string[];
    negative_local_styles: string[];
    duration_ms: number;
    lines: string[];
  }>;
};
export type ElevenLabsMusicBody =
  | { model_id: ElevenLabsModelId; prompt: string; music_length_ms: number; force_instrumental: boolean }
  | { model_id: ElevenLabsModelId; composition_plan: ChunkPlan | SectionPlan };

/** The lyrics fit no valid plan for the requested length (v1 only: too many lines for its 3 s sections). */
export class ElevenLabsPlanError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsPlanError';
  }
}

const SECTION_TAG = /^\[([^[\]]*\S[^[\]]*)\]$/;
const tagName = (line: string): string | undefined => SECTION_TAG.exec(line)?.[1].trim();

const parseSections = (lyrics: string): Section[] => {
  const sections: Section[] = [];
  for (const line of lyrics.split(/\r?\n/).map(text => text.trim())) {
    const name = tagName(line);
    if (name !== undefined) sections.push({ name, lines: [] });
    else if (line.length > 0) {
      if (sections.length === 0) sections.push({ name: UNTAGGED_SECTION, lines: [] });
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
};

const splitLines = (section: Section, maxLines: number): Section[] => {
  if (section.lines.length <= maxLines) return [section];
  const parts: Section[] = [];
  for (let at = 0; at < section.lines.length; at += maxLines) {
    parts.push({ name: section.name, lines: section.lines.slice(at, at + maxLines) });
  }
  return parts;
};

/**
 * Keeps at most as many sections as the length allows at 3 s each, leaving room for the extra chunks that
 * splitting a section longer than 120 s adds (at most one per full 120 s of the total).
 */
const fitSectionCount = (sections: Section[], totalMs: number): Section[] => {
  const maxSections = Math.max(
    1,
    Math.min(MAX_CHUNKS - Math.floor(totalMs / MAX_CHUNK_MS), Math.floor(totalMs / MIN_CHUNK_MS))
  );
  if (sections.length <= maxSections) return sections;
  const kept = sections.slice(0, maxSections);
  const last = kept[maxSections - 1];
  kept[maxSections - 1] = {
    name: last.name,
    lines: [...last.lines, ...sections.slice(maxSections).flatMap(section => section.lines)],
  };
  return kept;
};

/** 3 s each, then the rest by line count (weight at least 1) with largest-remainder rounding, so the sum is exact. */
const allocateDurations = (sections: Section[], totalMs: number): TimedSection[] => {
  const weights = sections.map(section => Math.max(1, section.lines.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const spareMs = totalMs - MIN_CHUNK_MS * sections.length;
  const shares = weights.map(weight => (spareMs * weight) / totalWeight);
  const durations = shares.map(share => MIN_CHUNK_MS + Math.floor(share));
  let leftover = totalMs - durations.reduce((sum, ms) => sum + ms, 0);
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (leftover === 0) break;
    durations[index] += 1;
    leftover -= 1;
  }
  return sections.map((section, index) => ({ ...section, durationMs: durations[index] }));
};

/** A section over 120 s becomes several chunks: its lines go with the first, the rest continue it. */
const splitLong = (section: TimedSection): TimedSection[] => {
  const parts = Math.ceil(section.durationMs / MAX_CHUNK_MS);
  if (parts <= 1) return [section];
  const baseMs = Math.floor(section.durationMs / parts);
  const extraMs = section.durationMs - baseMs * parts;
  return Array.from({ length: parts }, (_, index) => ({
    name: section.name,
    lines: index === 0 ? section.lines : [],
    durationMs: baseMs + (index < extraMs ? 1 : 0),
  }));
};

const planSections = (lyrics: string, totalMs: number, maxLinesPerSection?: number): TimedSection[] => {
  const parsed = parseSections(lyrics);
  const sections = parsed.length > 0 ? parsed : [{ name: UNTAGGED_SECTION, lines: [] }];
  const split = maxLinesPerSection ? sections.flatMap(section => splitLines(section, maxLinesPerSection)) : sections;
  const fitted = fitSectionCount(split, totalMs);
  if (maxLinesPerSection && fitted.some(section => section.lines.length > maxLinesPerSection)) {
    throw new ElevenLabsPlanError(`${PREFIX}_lyrics_too_many_lines_for_duration`);
  }
  return allocateDurations(fitted, totalMs).flatMap(splitLong);
};

const chunkPlan = (request: ValidatedMusicRequest, lyrics: string, totalMs: number): ChunkPlan => ({
  chunks: planSections(lyrics, totalMs).map(section => ({
    text: [`[${section.name}]`, ...section.lines].join('\n'),
    duration_ms: section.durationMs,
    positive_styles: [request.prompt],
    negative_styles: [],
  })),
});

const sectionPlan = (request: ValidatedMusicRequest, lyrics: string, totalMs: number): SectionPlan => ({
  positive_global_styles: [request.prompt],
  negative_global_styles: [],
  sections: planSections(lyrics, totalMs, MAX_V1_SECTION_LINES).map(section => ({
    section_name: section.name.slice(0, MAX_V1_SECTION_NAME_CHARS),
    positive_local_styles: [],
    negative_local_styles: [],
    duration_ms: section.durationMs,
    lines: section.lines,
  })),
});

/**
 * Without lyrics the prompt steers everything. With lyrics a composition plan carries them, so the lines are sung
 * as written, and the prompt becomes its style. `prompt` and `composition_plan` are mutually exclusive.
 * Throws ElevenLabsPlanError when the lyrics cannot fit the length.
 */
export const buildElevenLabsMusicBody = (request: ValidatedMusicRequest): ElevenLabsMusicBody => {
  const model_id = request.model;
  if (!isElevenLabsModel(model_id)) throw new Error(`${PREFIX}_unsupported_model: ${model_id}`);
  const totalMs = request.durationSeconds * 1000;
  if (!request.lyrics) {
    return { model_id, prompt: request.prompt, music_length_ms: totalMs, force_instrumental: request.instrumental };
  }
  const composition_plan =
    model_id === 'music_v1'
      ? sectionPlan(request, request.lyrics, totalMs)
      : chunkPlan(request, request.lyrics, totalMs);
  return { model_id, composition_plan };
};

const PlanSchema = z.looseObject({
  chunks: z.array(z.looseObject({ text: z.string() })).optional(),
  sections: z.array(z.looseObject({ lines: z.array(z.string()) })).optional(),
});
const MetadataSchema = z.looseObject({ composition_plan: PlanSchema.nullish() });
type ReturnedPlan = z.infer<typeof PlanSchema>;

const ErrorDetailSchema = z.looseObject({
  detail: z.looseObject({ status: z.string().optional(), code: z.string().optional() }),
});

const chunkLines = (text: string): string[] => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  return lines.length > 0 && tagName(lines[0]) !== undefined ? lines.slice(1) : lines;
};

export const lyricsFromPlan = (plan: ReturnedPlan | null | undefined): string | undefined => {
  const sections = plan?.chunks
    ? plan.chunks.map(chunk => chunkLines(chunk.text))
    : (plan?.sections ?? []).map(section => section.lines.map(line => line.trim()).filter(line => line.length > 0));
  const text = sections
    .filter(lines => lines.length > 0)
    .map(lines => lines.join('\n'))
    .join('\n\n');
  return text.length > 0 ? text : undefined;
};

type Part = { contentType: string; body: Buffer };

export const boundaryOf = (contentType: string | null): string | undefined => {
  if (!contentType?.toLowerCase().startsWith('multipart/')) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
};

const partOf = (raw: Buffer): Part => {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return { contentType: '', body: raw };
  const headers = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const contentType = headers
    .find(header => header.toLowerCase().startsWith('content-type:'))
    ?.slice('content-type:'.length)
    .trim();
  return { contentType: contentType ?? '', body: raw.subarray(headerEnd + 4) };
};

/** Binary-safe multipart/mixed split (RFC 2046, CRLF line endings); undefined when the body is not one. */
export const parseMultipart = (body: Buffer, boundary: string): Part[] | undefined => {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const separator = Buffer.from(`\r\n--${boundary}`, 'latin1');
  if (body.indexOf(delimiter) !== 0) return undefined;
  const parts: Part[] = [];
  let cursor = delimiter.length;
  while (body.subarray(cursor, cursor + 2).toString('latin1') !== '--') {
    if (body.subarray(cursor, cursor + 2).toString('latin1') !== '\r\n') return undefined;
    const start = cursor + 2;
    const end = body.indexOf(separator, start);
    if (end < 0) return undefined;
    parts.push(partOf(body.subarray(start, end)));
    cursor = end + separator.length;
  }
  return parts;
};

const parseJson = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
};

const failed = (code: string, retryable: boolean, raw: unknown): ProviderTerminalResult => ({
  status: 'failed',
  retryable,
  message: `${PREFIX}_${code}`,
  raw,
});

const toFailure = (status: number, raw: unknown): ProviderTerminalResult => {
  const detail = ErrorDetailSchema.safeParse(raw);
  const providerStatus = detail.success ? detail.data.detail.status : undefined;
  if (providerStatus && REFUSAL_STATUSES.has(providerStatus)) {
    return { status: 'blocked', reason: COPYRIGHT_REASON, raw };
  }
  const providerCode = providerStatus ?? (detail.success ? detail.data.detail.code : undefined);
  const code = providerCode ? providerCode.toLowerCase().replace(/[^a-z0-9]+/g, '_') : `http_${status}`;
  // Only a 429 proves nothing was generated; a 5xx may have rendered (and billed) a song, any other 4xx repeats.
  return failed(code, status === 429, raw);
};

const toTerminal = (
  request: ValidatedMusicRequest,
  response: Response,
  body: Buffer,
  ctx: ProviderContext
): ProviderTerminalResult => {
  const boundary = boundaryOf(response.headers.get('content-type'));
  const parts = boundary ? parseMultipart(body, boundary) : undefined;
  const jsonPart = parts?.find(part => part.contentType.toLowerCase().startsWith('application/json'));
  const metadata = jsonPart ? MetadataSchema.safeParse(parseJson(jsonPart.body)) : undefined;
  // Answered and billed, but unreadable: a shape change to fix, not something a retry gets past.
  if (!parts || !metadata?.success) return failed('unparseable', false, body.subarray(0, 2048).toString('utf8'));
  const audio = parts.find(part => part.contentType.toLowerCase().startsWith('audio/') && part.body.length > 0);
  if (!audio) {
    // Not observed live; a response without audio must not bill the user for a song.
    ctx.logger.warn(`${PREFIX}_succeeded_without_audio`, { songId: response.headers.get('song-id') });
    return { status: 'blocked', reason: NO_AUDIO_REASON, raw: metadata.data };
  }
  const contentType = audio.contentType.split(';')[0].trim().toLowerCase();
  // The frame scan would false-sync on non-MP3 audio, so only MP3 is measured.
  const durationSeconds = contentType === MP3_CONTENT_TYPE ? mp3DurationSeconds(audio.body) : undefined;
  if (durationSeconds === undefined) ctx.logger.warn(`${PREFIX}_duration_unread`, { contentType });
  const lyrics = request.instrumental ? undefined : lyricsFromPlan(metadata.data.composition_plan);
  return {
    status: 'succeeded',
    output: { kind: 'inline', base64: audio.body.toString('base64'), contentType },
    ...(durationSeconds !== undefined && { reportedDurationSeconds: durationSeconds }),
    ...(lyrics !== undefined && { lyrics }),
  };
};

/** ElevenLabs Music over the /v1/music/detailed REST endpoint, one blocking call per song. */
export class ElevenLabsMusicProvider implements SyncGenerationProvider<
  ElevenLabsProviderId,
  ElevenLabsModelId,
  ValidatedMusicRequest
> {
  readonly mode = 'sync' as const;
  readonly id = 'elevenlabs' as const;
  readonly models = ELEVENLABS_MODELS;

  async generate(
    request: ValidatedMusicRequest,
    _inputs: ResolvedInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    let requestBody: ElevenLabsMusicBody;
    try {
      requestBody = buildElevenLabsMusicBody(request);
    } catch (error) {
      if (error instanceof ElevenLabsPlanError) return failed('lyrics_unfit', false, error.message);
      throw error;
    }
    let response: Response;
    try {
      response = await fetch(MUSIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': ctx.apiKey },
        body: JSON.stringify(requestBody),
        signal: ctx.signal,
      });
    } catch (error) {
      // Unknown outcome: the song may have been generated and billed, so the job must not call again.
      throw new ProviderSubmitError(`${PREFIX}_transport`, false, String(error));
    }
    if (!response.ok) return toFailure(response.status, await readJson(response));
    let body: Buffer;
    try {
      body = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderOutputTooLargeError) throw error;
      // Cut off mid-body: the song was generated and billed, so the same unknown-outcome error as a failed request.
      throw new ProviderSubmitError(`${PREFIX}_transport`, false, String(error));
    }
    return toTerminal(request, response, body, ctx);
  }

  async fetchOutput(output: ProviderOutput): Promise<Buffer> {
    if (output.kind !== 'inline') throw new Error(`${PREFIX}_unexpected_url_output`);
    return Buffer.from(output.base64, 'base64');
  }
}
