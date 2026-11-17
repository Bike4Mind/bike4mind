import {
  ImageJobRequestSchema,
  MUSIC_MODEL_CATALOG,
  TERMINAL_GENERATION_JOB_STATES,
  VIDEO_MODEL_CATALOG,
  getImageModelCatalogEntry,
  validateImageRequest,
  type AspectRatio,
  type GenerationJobState,
  type ImageJobInput,
  type MusicModelId,
  type VideoModelCapabilities,
  type VideoModelId,
} from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import { paidPlanRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import { buildJobIdempotencyKey, isReplayOfDeadJob } from '../generationJobTool';
import type { ImageJobRequestDraft } from '../imageGeneration/imageJobTool';
import type { ProductionJobView, ProductionToolConfig } from './config';

type Context = Omit<ToolContext, 'config'>;

export type Submitted = { ok: true; jobIds: string[] } | { ok: false; message: string };

const DEFAULT_WAIT_TIMEOUT_MS = 150_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
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
 * Polls until every job is terminal or the wait runs out, whichever is first. The agent loop has no abort signal
 * to honour, so the bound is what keeps one tool call from holding the run.
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

/** The first draft the model accepts; an aspect ratio it cannot make is dropped (cover-fit crops it later). */
function imageRequestFor(
  model: string,
  prompt: string,
  references: readonly string[],
  aspectRatio: string
): ImageJobRequestDraft | null {
  const parsed = ImageJobRequestSchema.shape.model.safeParse(model);
  if (!parsed.success) return null;
  const entry = getImageModelCatalogEntry(parsed.data);
  const maxReferences = entry.modes.generate?.inputs.reference?.max ?? 0;
  const inputs: ImageJobInput[] = references
    .slice(0, maxReferences)
    .map(fileId => ({ role: 'reference', fileId: fileId.toLowerCase() }));
  const base = { model, mode: 'generate' as const, prompt, ...(inputs.length > 0 && { inputs }) };
  for (const draft of [{ ...base, aspectRatio }, base]) {
    if (validateImageRequest({ ...draft, count: 1 }, entry).ok) return draft;
  }
  return null;
}

// A refusal that is about the model, not the request: the next model may well take it.
const MODEL_REFUSALS = new Set(['model_unavailable', 'unsupported_by_model']);

/** Starts `count` takes for one shot on the best usable model that accepts the request. */
export async function submitShotImages(
  context: Context,
  config: ProductionToolConfig,
  shot: { prompt: string; references: readonly string[]; aspectRatio: string },
  count: number
): Promise<Submitted> {
  const image = config.image;
  if (!image) return { ok: false, message: 'Image generation is not available for this run.' };
  let lastRefusal = 'No usable image model takes reference images.';
  for (const model of config.imageModels) {
    const request = imageRequestFor(model, shot.prompt, shot.references, shot.aspectRatio);
    if (!request) continue;
    let result: Awaited<ReturnType<typeof image.createJobs>> | undefined;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        result = await image.createJobs({
          user: jobUser(context),
          request,
          count,
          source: 'agent',
          apiKeyId: context.apiKeyId,
          questId: context.questId,
          idempotencyKey: attemptKey(context, { request, count }, attempt),
        });
        const replayed = result;
        if (!replayed.ok || !replayed.jobs.every(job => isReplayOfDeadJob(replayed.created, job.state))) break;
        if (attempt === MAX_ATTEMPTS - 1) return { ok: false, message: DEAD_REPLAY_MESSAGE };
      }
    } catch (error) {
      lastRefusal = paidPlanRefusalOrRethrow(context, error, model, 'production_generate_shot');
      continue;
    }
    if (!result) continue;
    if (result.ok) {
      await context.statusUpdate({ generationJobs: result.jobs.map(job => ({ id: job.id, kind: 'image' as const })) });
      return { ok: true, jobIds: result.jobs.map(job => job.id) };
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
  usable.find(id => {
    const caps = VIDEO_MODEL_CATALOG[id];
    return caps.modes.includes('image_to_video') && (caps.inputs.first_frame?.max ?? 0) > 0;
  });

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
  try {
    const result = await createWithRetry(attempt =>
      video.createJob({
        user: jobUser(context),
        request,
        source: 'agent',
        apiKeyId: context.apiKeyId,
        questId: context.questId,
        idempotencyKey: attemptKey(context, request, attempt),
      })
    );
    if (!result) return { ok: false, message: DEAD_REPLAY_MESSAGE };
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

/** A model that can make a track of about `seconds`: an exact-length model first, since the bed is cut to fit. */
export function pickMusicModel(usable: readonly MusicModelId[], seconds: number): MusicModelId | undefined {
  const fits = (id: MusicModelId) => musicRange(id).max >= seconds;
  return (
    usable.find(id => fits(id) && MUSIC_MODEL_CATALOG[id].duration.control === 'exact') ??
    usable.find(fits) ??
    usable[0]
  );
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
