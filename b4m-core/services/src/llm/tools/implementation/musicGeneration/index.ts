import { MUSIC_MODEL_CATALOG, type MusicGenerationRequest, type MusicModelId } from '@bike4mind/common';
import type { CreateMusicJobInput, CreateMusicJobResult } from '../../../../musicJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import {
  buildJobIdempotencyKey,
  buildUnavailableTool,
  isReplayOfDeadJob,
  toToolParameters,
} from '../generationJobTool';
import { buildMusicToolSchema, type MusicToolArgs } from './buildSchema';

// The agent-mode per-run cap (agentExecutor.musicToolConfig.ts) refuses here; createMusicJob never returns this code,
// so it stays out of CreateMusicJobErrorCode, whose codes the public music-generations route must all publish.
type TrackLimitRefusal = { ok: false; status: 403; code: 'track_limit_reached'; message: string };

export type MusicToolConfig = {
  usableModels: readonly MusicModelId[];
  createJob: (input: CreateMusicJobInput) => Promise<CreateMusicJobResult | TrackLimitRefusal>;
};

type PopulatedMusicToolConfig = MusicToolConfig & { usableModels: readonly [MusicModelId, ...MusicModelId[]] };

export const isMusicToolConfig = (value: unknown): value is PopulatedMusicToolConfig =>
  typeof value === 'object' &&
  value !== null &&
  'createJob' in value &&
  typeof value.createJob === 'function' &&
  'usableModels' in value &&
  Array.isArray(value.usableModels) &&
  value.usableModels.length > 0;

// Providers refuse prompts that name real artists, so catch "style of <Name>" shapes before a job exists.
// Genre, place and style words are exempt so "in the style of Motown" or "sounds like Latin jazz" pass.
// The phrase matches in any case (sentence-initial "In the style of"); the name must start with a capital.
const STYLE_PHRASE = /\b(?:in the style of|in the vein of|sounds like|inspired by)\s+(?:the\s+)?/gi;
// A dot only joins letters, so the run ends at a sentence boundary instead of swallowing the next sentence.
const CAPITALIZED_RUN = /^(?:\p{Lu}(?:[\p{L}\p{N}'-]|\.(?=\p{L}))*[ \t]?)+/u;

const STYLE_WORDS = new Set([
  'latin',
  'spanish',
  'motown',
  'celtic',
  'nashville',
  'delta',
  'baroque',
  'gospel',
  'jazz',
  'blues',
  'african',
  'brazilian',
  'cuban',
  'irish',
  'french',
  'german',
  'italian',
  'asian',
  'caribbean',
  'appalachian',
  'memphis',
  'chicago',
  'detroit',
  'classical',
  'romantic',
  'medieval',
  'renaissance',
  'american',
  'british',
  'western',
]);

// A run can end a sentence or carry a possessive ("in the style of Motown.", "Nashville's"), so strip both before lookup.
const toStyleWordKey = (word: string): string =>
  word
    .toLowerCase()
    .replace(/[.'-]+$/, '')
    .replace(/'s$/, '');

export const ARTIST_REFERENCE_REFUSAL =
  'Music generation failed (artist_reference): the prompt appears to name a real artist or band. ' +
  'Rewrite it describing genre, mood, instruments, tempo and era instead of names, and call music_generation again.';

export const namesArtistReference = (prompt: string): boolean =>
  Array.from(prompt.matchAll(STYLE_PHRASE)).some(match => {
    const run = prompt.slice(match.index + match[0].length).match(CAPITALIZED_RUN)?.[0];
    if (run === undefined) return false;
    // A hyphen joins two style words ("Celtic-Irish") and a lone letter ("A minor") is never a name.
    return run.split(/[-\s]+/).some(word => {
      const key = toStyleWordKey(word);
      return key.length > 1 && !STYLE_WORDS.has(key);
    });
  });

// Defaults (length, instrumental) are left to createMusicJob, which resolves them per model.
const toRequest = (args: MusicToolArgs): MusicGenerationRequest => ({
  model: args.model,
  prompt: args.prompt,
  ...('lyrics' in args && typeof args.lyrics === 'string' && { lyrics: args.lyrics }),
  ...(args.instrumental !== undefined && { instrumental: args.instrumental }),
  ...(args.durationSeconds !== undefined && { durationSeconds: args.durationSeconds }),
});

// Billing lives in createMusicJob (the job engine), so this tool deliberately never uses context.onStart/onFinish.
export const musicGenerationTool: ToolDefinition = {
  name: 'music_generation',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isMusicToolConfig(config)) return buildUnavailableTool('music_generation', 'Music generation');
    const { schema, description } = buildMusicToolSchema(config.usableModels);
    // The guard is a heuristic, so it refuses once per built tool (one chat turn or agent run): a false positive such
    // as "inspired by Shakespeare" costs one rephrase instead of looping until the tool-call cap with no song.
    let artistRefusalSent = false;
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        if (!artistRefusalSent && namesArtistReference(args.prompt)) {
          artistRefusalSent = true;
          return ARTIST_REFERENCE_REFUSAL;
        }
        const request = toRequest(args);
        const result = await config.createJob({
          user: { id: context.userId, organizationId: context.organizationId ?? null },
          request,
          source: 'agent',
          sessionId: context.sessionId,
          questId: context.questId,
          idempotencyKey: buildJobIdempotencyKey(context.userId, context.questId, request),
        });
        if (!result.ok) return `Music generation failed (${result.code}): ${result.message}`;
        if (isReplayOfDeadJob(result.created, result.job.state)) {
          const reason = result.job.error?.code ?? result.job.state;
          return `Music generation failed (${reason}): an identical request already ended without a song.`;
        }
        await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'music' }] });
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: MUSIC_MODEL_CATALOG[args.model].typicalRenderSeconds,
        });
      },
      toolSchema: { name: 'music_generation', description, parameters: toToolParameters(schema) },
    };
  },
};
