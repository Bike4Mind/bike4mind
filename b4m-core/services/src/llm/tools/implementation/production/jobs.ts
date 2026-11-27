import {
  ImageJobRequestSchema,
  MUSIC_MODEL_CATALOG,
  TERMINAL_GENERATION_JOB_STATES,
  VIDEO_MODEL_CATALOG,
  getImageModelCatalogEntry,
  selectShotReferences,
  validateImageRequest,
  type AspectRatio,
  type GenerationJobState,
  type ImageJobInput,
  type MusicModelId,
  type StudioCharacter,
  type VideoModelCapabilities,
  type VideoModelId,
} from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import { paidPlanRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import { buildJobIdempotencyKey, isReplayOfDeadJob } from '../generationJobTool';
import type { ImageJobRequestDraft } from '../imageGeneration/imageJobTool';
import type { ProductionJobView, ProductionToolConfig } from './config';

type Context = Omit<ToolContext, 'config'>;

export type Submitted =
  | { ok: true; jobIds: string[]; model?: string; charactersDropped?: string[] }
  | { ok: false; message: string; notReady?: true };

const DEFAULT_WAIT_TIMEOUT_MS = 150_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
// A new take is refused as a video input until its upload moderation passes (loadInputFabFile reads only a 'clean'
// file), which takes some seconds after the image job saves it.
const DEFAULT_INPUT_READY_TIMEOUT_MS = 60_000;
const INPUT_NOT_READY = 'input_image_not_found';
const MAX_PROMPT_CHARS = 4000;

const jobUser = (context: Context) => ({
  id: context.userId,
  organizationId: context.organizationId ?? null,
  adminRoleWithheld: !context.user.isAdmin,
});

const clip = (text: string): string => text.slice(0, MAX_PROMPT_CHARS);

export const isTerminal = (job: ProductionJobView): boolean => TERMINAL_GENERATION_JOB_STATES.includes(job.state);

/**
 * Each call keys its job by the request, so a re-call while a job runs attaches to it instead of paying again. A
 * replay of a job that already failed would hand the same dead job back forever, so a failed request is retried
 * under the next attempt's key, up to this many jobs per identical request in one Quest.
 */
const MAX_ATTEMPTS = 3;

export const attemptKey = (context: Context, request: unknown, attempt: number) =>
  buildJobIdempotencyKey(context.userId, context.questId, attempt === 0 ? request : { request, attempt });

export const DEAD_REPLAY_MESSAGE = 'failed: this exact request already failed the most times it is retried; change it';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls until every job is terminal or the wait runs out, whichever is first. It also stops when the signal aborts;
 * the bound is what keeps one tool call from holding the run.
 */
export async function waitForJobs(
  config: Pick<ProductionToolConfig, 'findJobs' | 'waitTimeoutMs' | 'pollIntervalMs'>,
  ids: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, ProductionJobView>> {
  const deadline = Date.now() + (config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const interval = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let jobs = new Map<string, ProductionJobView>();
  if (ids.length === 0) return jobs;
  for (;;) {
    jobs = new Map((await config.findJobs(ids)).map(job => [job.id, job]));
    const done = ids.every(id => {
      const job = jobs.get(id);
      return job !== undefined && isTerminal(job);
    });
    if (done || Date.now() + interval > deadline || signal?.aborted) return jobs;
    await sleep(interval);
  }
}

/** The request one shot's takes are made from: the shot prompt, steered to keep the referenced product as it is. */
export function buildShotImagePrompt(prompt: string, brandColors: readonly string[], hasProduct: boolean): string {
  const parts = [prompt.trim()];
  if (hasProduct)
    parts.push('Feature the product from the reference image exactly as it appears: same shape, label and colours.');
  if (brandColors.length > 0) parts.push(`Brand colours: ${brandColors.join(', ')}.`);
  return clip(parts.join(' '));
}

/** Names the characters whose images were passed, so the model ties each reference to a person. */
export function characterPromptLine(characters: readonly Pick<StudioCharacter, 'name'>[]): string {
  if (characters.length === 0) return '';
  const names = characters.map(character => character.name).join(', ');
  return `Feature ${names} from the reference images exactly as they appear: same face, hair, build and outfit.`;
}

/** A product packshot drawn from the brief alone, for a production that has no product image to reference. */
export function buildPackshotPrompt(summary: string): string {
  return clip(
    `Product packshot of the product in this brief: ${summary.trim()}. The whole product, centred, on a plain light ` +
      'background, evenly lit. No text, no logos added, no people.'
  );
}

const isInputNotReady = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  'ok' in result &&
  result.ok === false &&
  'code' in result &&
  result.code === INPUT_NOT_READY;

/**
 * Re-runs `create` while its input file is still in its upload safety check, until inputReadyTimeoutMs runs out or the
 * run aborts. A just-made file (a take, a product look) is refused as an input until that check passes.
 */
async function untilInputReady<R>(
  context: Context,
  config: Pick<ProductionToolConfig, 'inputReadyTimeoutMs' | 'pollIntervalMs'>,
  create: () => Promise<R>
): Promise<R> {
  const deadline = Date.now() + (config.inputReadyTimeoutMs ?? DEFAULT_INPUT_READY_TIMEOUT_MS);
  const interval = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let result = await create();
  while (isInputNotReady(result) && Date.now() + interval <= deadline) {
    if (context.getAbortSignal?.()?.aborted) break;
    await sleep(interval);
    result = await create();
  }
  return result;
}

/**
 * The first draft the model accepts; an aspect ratio it cannot make is dropped (cover-fit crops it later). The
 * references are cut to the model's cap by selectShotReferences, which also reports the characters that lost a slot.
 */
function imageRequestFor(
  model: string,
  prompt: string,
  references: readonly string[],
  characters: readonly StudioCharacter[],
  aspectRatio: string
): { draft: ImageJobRequestDraft; charactersDropped: StudioCharacter[] } | null {
  const parsed = ImageJobRequestSchema.shape.model.safeParse(model);
  if (!parsed.success) return null;
  const entry = getImageModelCatalogEntry(parsed.data);
  const maxReferences = entry.modes.generate?.inputs.reference?.max ?? 0;
  const selection = selectShotReferences({ productFileIds: references, characters }, maxReferences);
  const inputs: ImageJobInput[] = selection.fileIds.map(fileId => ({
    role: 'reference',
    fileId: fileId.toLowerCase(),
  }));
  // Leading with the names keeps them when a long prompt is cut to the cap.
  const line = characterPromptLine(selection.characters);
  const fullPrompt = line ? clip(`${line} ${prompt}`) : prompt;
  const base = { model, mode: 'generate' as const, prompt: fullPrompt, ...(inputs.length > 0 && { inputs }) };
  for (const draft of [{ ...base, aspectRatio }, base]) {
    if (validateImageRequest({ ...draft, count: 1 }, entry).ok)
      return { draft, charactersDropped: selection.droppedCharacters };
  }
  return null;
}

// A refusal that is about the model, not the request: the next model may well take it.
const MODEL_REFUSALS = new Set(['model_unavailable', 'unsupported_by_model']);

/**
 * Starts `count` takes for one shot on the best usable model that accepts the request. A `purpose` in place of a shot
 * keys a production-wide image (the product look) apart from every shot's takes.
 */
export async function submitShotImages(
  context: Context,
  config: ProductionToolConfig,
  shot: {
    prompt: string;
    references: readonly string[];
    /** The shot's featured characters, in order; they share the model's reference cap with `references`. */
    characters?: readonly StudioCharacter[];
    /** A reference is still in its upload safety check, so a refusal of it is waited out instead of reported. */
    referencesChecking?: boolean;
    aspectRatio: string;
    compositionId: string;
  } & ({ shotId: string } | { purpose: 'product-look' }),
  count: number
): Promise<Submitted> {
  const image = config.image;
  if (!image) return { ok: false, message: 'Image generation is not available for this run.' };
  let lastRefusal = 'No usable image model takes reference images.';
  for (const model of config.imageModels) {
    const built = imageRequestFor(model, shot.prompt, shot.references, shot.characters ?? [], shot.aspectRatio);
    if (!built) continue;
    const request = built.draft;
    const target = 'shotId' in shot ? { shotId: shot.shotId } : { purpose: shot.purpose };
    const createAll = async () => {
      let created: Awaited<ReturnType<typeof image.createJobs>> | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        created = await image.createJobs({
          user: jobUser(context),
          request,
          count,
          source: 'agent',
          apiKeyId: context.apiKeyId,
          questId: context.questId,
          idempotencyKey: attemptKey(
            context,
            { request, count, compositionId: shot.compositionId, ...target },
            attempt
          ),
        });
        const replayed = created;
        if (!replayed.ok || !replayed.jobs.every(job => isReplayOfDeadJob(replayed.created, job.state))) return created;
      }
      return 'dead' as const;
    };
    let result: Awaited<ReturnType<typeof image.createJobs>> | undefined;
    try {
      // With no reference in its safety check, the refusal is permanent (not owned, deleted, blocked): report it.
      const created = shot.referencesChecking ? await untilInputReady(context, config, createAll) : await createAll();
      if (created === 'dead') return { ok: false, message: DEAD_REPLAY_MESSAGE };
      if (shot.referencesChecking && isInputNotReady(created)) {
        return { ok: false, notReady: true, message: 'a reference image is not ready yet (its safety check)' };
      }
      result = created;
    } catch (error) {
      lastRefusal = paidPlanRefusalOrRethrow(context, error, model, 'production_generate_shot');
      continue;
    }
    if (!result) continue;
    if (result.ok) {
      await context.statusUpdate({ generationJobs: result.jobs.map(job => ({ id: job.id, kind: 'image' as const })) });
      const dropped = built.charactersDropped.map(character => character.name);
      return {
        ok: true,
        jobIds: result.jobs.map(job => job.id),
        model,
        ...(dropped.length > 0 && { charactersDropped: dropped }),
      };
    }
    if (!MODEL_REFUSALS.has(result.code)) return { ok: false, message: `${result.code}: ${result.message}` };
    lastRefusal = `${result.code}: ${result.message}`;
  }
  return { ok: false, message: lastRefusal };
}

export type SingleJobResult =
  { ok: false; code: string; message: string } | { ok: true; created: boolean; job: { state: GenerationJobState } };

/** Creates one job, moving past replays of failed attempts; undefined when every attempt has failed. */
export async function createWithRetry<R extends SingleJobResult>(
  create: (attempt: number) => Promise<R>
): Promise<R | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await create(attempt);
    if (!result.ok || !isReplayOfDeadJob(result.created, result.job.state)) return result;
  }
  return undefined;
}

/** The clip length to ask for: the shot's length, held to what the model can make. */
export function videoDurationFor(caps: VideoModelCapabilities, shotMs: number): number {
  const wanted = Math.ceil(shotMs / 1000);
  const { duration } = caps;
  if (duration.kind === 'discrete') {
    return duration.values.find(value => value >= wanted) ?? Math.max(...duration.values);
  }
  const stepped = duration.min + Math.ceil((wanted - duration.min) / duration.step) * duration.step;
  return Math.min(Math.max(stepped, duration.min), duration.max);
}

export const pickVideoModel = (usable: readonly VideoModelId[]): VideoModelId | undefined =>
  realModelsFirst(
    usable,
    id => VIDEO_MODEL_CATALOG[id].provider === 'test',
    ids =>
      ids.find(id => {
        const caps = VIDEO_MODEL_CATALOG[id];
        return caps.modes.includes('image_to_video') && (caps.inputs.first_frame?.max ?? 0) > 0;
      })
  );

/** Animates a chosen still into a clip of `durationSeconds`. */
export async function submitShotClip(
  context: Context,
  config: ProductionToolConfig,
  input: { model: VideoModelId; prompt: string; stillFileId: string; durationSeconds: number; aspectRatio: string }
): Promise<Submitted> {
  const video = config.video;
  if (!video) return { ok: false, message: 'Video generation is not available for this run.' };
  const caps = VIDEO_MODEL_CATALOG[input.model];
  const aspectRatio = caps.aspectRatios.find(ratio => ratio === input.aspectRatio) ?? caps.defaults.aspectRatio;
  // The legacy single-image field, as video_generation sends it (see its toRequest): a handler from before
  // `inputs` cannot read an inputs-only payload.
  const request = {
    model: input.model,
    mode: 'image_to_video' as const,
    prompt: clip(input.prompt),
    durationSeconds: input.durationSeconds,
    aspectRatio: aspectRatio as AspectRatio,
    resolution: caps.defaults.resolution,
    inputImageFileId: input.stillFileId,
  };
  const create = () =>
    createWithRetry(attempt =>
      video.createJob({
        user: jobUser(context),
        request,
        source: 'agent',
        apiKeyId: context.apiKeyId,
        questId: context.questId,
        idempotencyKey: attemptKey(context, request, attempt),
      })
    );
  try {
    const result = await untilInputReady(context, config, create);
    if (!result) return { ok: false, message: DEAD_REPLAY_MESSAGE };
    if (!result.ok && result.code === INPUT_NOT_READY) {
      return { ok: false, notReady: true, message: 'the chosen take is not ready to animate yet (its safety check)' };
    }
    if (!result.ok) return { ok: false, message: `${result.code}: ${result.message}` };
    await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'video' }] });
    return { ok: true, jobIds: [result.job.id] };
  } catch (error) {
    return { ok: false, message: paidPlanRefusalOrRethrow(context, error, input.model, 'production_generate_shot') };
  }
}

const musicRange = (id: MusicModelId): { min: number; max: number } => {
  const duration = MUSIC_MODEL_CATALOG[id].duration;
  return duration.control === 'fixed' ? { min: duration.seconds, max: duration.seconds } : duration;
};

/**
 * Runs `pick` over the real models first: the 'test' provider stubs (sample clip, sample track) are usable where an
 * environment enables them, and a production made from them is useless unless nothing else is usable.
 */
function realModelsFirst<T>(
  usable: readonly T[],
  isStub: (id: T) => boolean,
  pick: (ids: readonly T[]) => T | undefined
) {
  return pick(usable.filter(id => !isStub(id))) ?? pick(usable.filter(isStub));
}

/** A model that can make a track of about `seconds`: an exact-length model first, since the bed is cut to fit. */
export function pickMusicModel(usable: readonly MusicModelId[], seconds: number): MusicModelId | undefined {
  const fits = (id: MusicModelId) => musicRange(id).max >= seconds;
  return realModelsFirst(
    usable,
    id => MUSIC_MODEL_CATALOG[id].provider === 'test',
    ids => ids.find(id => fits(id) && MUSIC_MODEL_CATALOG[id].duration.control === 'exact') ?? ids.find(fits) ?? ids[0]
  );
}

/** How much of a `totalMs` cut the model submitMusic would pick can cover; 0 when music is unavailable. */
export function musicReachMs(config: ProductionToolConfig, totalMs: number): number {
  const model = config.music && pickMusicModel(config.music.usableModels, totalMs / 1000);
  return model ? Math.min(totalMs, musicRange(model).max * 1000) : 0;
}

export async function submitMusic(
  context: Context,
  config: ProductionToolConfig,
  input: { prompt: string; seconds: number }
): Promise<Submitted> {
  const music = config.music;
  const model = music && pickMusicModel(music.usableModels, input.seconds);
  if (!music || !model) return { ok: false, message: 'Music generation is not available for this run.' };
  const { min, max } = musicRange(model);
  const request = {
    model,
    prompt: clip(input.prompt),
    instrumental: true,
    durationSeconds: Math.min(Math.max(Math.ceil(input.seconds), min), max),
  };
  try {
    const result = await createWithRetry(attempt =>
      music.createJob({
        user: jobUser(context),
        request,
        source: 'agent',
        apiKeyId: context.apiKeyId,
        sessionId: context.sessionId,
        questId: context.questId,
        idempotencyKey: attemptKey(context, request, attempt),
      })
    );
    if (!result) return { ok: false, message: DEAD_REPLAY_MESSAGE };
    if (!result.ok) return { ok: false, message: `${result.code}: ${result.message}` };
    await context.statusUpdate({ generationJobs: [{ id: result.job.id, kind: 'music' }] });
    return { ok: true, jobIds: [result.job.id] };
  } catch (error) {
    return { ok: false, message: paidPlanRefusalOrRethrow(context, error, model, 'production_add_audio') };
  }
}

/** A failed job's reason for the model, or a note that it is still running. */
export function jobOutcome(job: ProductionJobView | undefined): string {
  if (!job) return 'not found';
  if (!isTerminal(job)) return `still ${job.state}`;
  return job.error ? `${job.state} (${job.error.code}): ${job.error.message}` : job.state;
}
