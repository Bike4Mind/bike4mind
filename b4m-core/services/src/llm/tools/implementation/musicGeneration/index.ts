import {
  MUSIC_MODEL_CATALOG,
  TERMINAL_GENERATION_JOB_STATES,
  type IGenerationJobDocument,
  type MusicGenerationRequest,
  type MusicModelId,
} from '@bike4mind/common';
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
  /** Reads a job back so a fast provider block can reach the model in-turn; without it a block only shows on the card. */
  findJob?: (jobId: string) => Promise<IGenerationJobDocument | null>;
  /** Called when the tool discards an unbilled blocked job in favour of a rephrase, so a per-run cap returns its slot. */
  releaseDiscardedJob?: (jobId: string) => Promise<void>;
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
const STYLE_PHRASE = /\b(?:in the style of|in the vein of|sounds like|inspired by)\s+(?:the\s+)?/gi;
// A dot joins letters inside a word ("D.J.") or follows a lone-capital initial ("J. Example"), continuing the run;
// any other dot ends it at a sentence boundary rather than swallowing the next sentence.
const CAPITALIZED_RUN = /^(?:\p{Lu}\.(?=[ \t]\p{Lu})[ \t]*|\p{Lu}(?:[\p{L}\p{N}'-]|\.(?=\p{L}))*[ \t]?)+/u;

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

export const PROVIDER_BLOCK_REFUSAL =
  'Music generation failed (content_blocked): the provider refused the prompt, most likely because it names or ' +
  'imitates a real artist, band or song. Rewrite it describing genre, mood, instruments, tempo and era instead, ' +
  'and call music_generation again.';

// The job runs after this call returns, but providers refuse a prompt within a few seconds, before rendering.
// Waiting this long catches most blocks in-turn; it delays every successful call by the same amount.
const EARLY_BLOCK_POLL_INTERVAL_MS = 1_000;
const EARLY_BLOCK_POLLS = 6;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The job once terminal, or null when it is still running after the wait, vanished, or the turn was stopped. */
const awaitEarlyTerminal = async (
  findJob: NonNullable<MusicToolConfig['findJob']>,
  jobId: string,
  signal: AbortSignal | undefined
): Promise<IGenerationJobDocument | null> => {
  for (let poll = 0; poll < EARLY_BLOCK_POLLS; poll++) {
    await sleep(EARLY_BLOCK_POLL_INTERVAL_MS);
    if (signal?.aborted) return null;
    const job = await findJob(jobId);
    if (!job) return null;
    if (TERMINAL_GENERATION_JOB_STATES.includes(job.state)) return job;
  }
  return null;
};

// A billed block keeps its chat card so the charge stays visible; an unbilled one needs no card.
const isUnbilledPromptBlock = (job: IGenerationJobDocument): boolean =>
  job.state === 'blocked' &&
  job.error?.code === 'content_blocked' &&
  !(job.kind === 'music' && job.payload.billedBlock === true);

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

// The wait is best effort: a failed read must not lose the card of a job that was already created and billed.
const awaitEarlyOutcome = async (
  findJob: NonNullable<MusicToolConfig['findJob']>,
  job: IGenerationJobDocument,
  context: Pick<ToolContext, 'logger' | 'getAbortSignal'>
): Promise<IGenerationJobDocument | null> => {
  if (TERMINAL_GENERATION_JOB_STATES.includes(job.state)) return job;
  try {
    return await awaitEarlyTerminal(findJob, job.id, context.getAbortSignal?.());
  } catch (error) {
    context.logger.warn('[music_generation] could not read the job back; reporting it as started', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

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
    // One rephrase per built tool instance, shared by the artist guard and an early provider block: the guard is a
    // heuristic, so a false positive such as "inspired by Example Soloist" costs one rephrase instead of looping
    // until the tool-call cap with no song, and a rephrased prompt that is blocked again falls through to the card.
    let rephraseRequested = false;
    // Jobs discarded for a rephrase never got a card; an identical retry must show it, or the block stays invisible.
    const discardedJobIds = new Set<string>();
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        if (!rephraseRequested && namesArtistReference(args.prompt)) {
          rephraseRequested = true;
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
          if (discardedJobIds.delete(result.job.id)) {
            await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'music' }] });
          }
          return `Music generation failed (${reason}): an identical request already ended without a song.`;
        }
        let outcome: IGenerationJobDocument | null = null;
        if (!rephraseRequested && config.findJob) {
          // Claimed before the wait so parallel calls in one turn cannot each be offered the rephrase.
          rephraseRequested = true;
          outcome = await awaitEarlyOutcome(config.findJob, result.job, context);
          if (outcome && isUnbilledPromptBlock(outcome)) {
            discardedJobIds.add(result.job.id);
            await config.releaseDiscardedJob?.(result.job.id);
            return PROVIDER_BLOCK_REFUSAL;
          }
          rephraseRequested = false;
        }
        await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'music' }] });
        if (outcome && outcome.state !== 'succeeded') {
          const reason = outcome.error?.code ?? outcome.state;
          return `Music generation failed (${reason}): the job ended without a song; its card shows the outcome.`;
        }
        return JSON.stringify({
          jobId: result.job.id,
          estimatedSeconds: MUSIC_MODEL_CATALOG[args.model].typicalRenderSeconds,
        });
      },
      toolSchema: { name: 'music_generation', description, parameters: toToolParameters(schema) },
    };
  },
};
