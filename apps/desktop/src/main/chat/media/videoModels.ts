import {
  ASPECT_RATIOS,
  estimateVideoCostCredits,
  RESOLUTION_TIERS,
  validateAgainstCapabilities,
  VIDEO_MODEL_CATALOG,
  VIDEO_MODEL_IDS,
  VIDEO_PROMPT_MAX_LENGTH,
  VideoModelSchema,
  type AspectRatio,
  type ResolutionTier,
  type VideoGenerationRequest,
  type VideoModel,
  type VideoModelCapabilities,
  type VideoModelId,
} from '@bike4mind/common';

/** The model the server turns on by default; preferred when it is offered. */
export const PREFERRED_VIDEO_MODEL = 'gemini-omni-1.1-flash';

/** Stands in for the uploaded file's id while validating: the upload happens only after approval. */
const PENDING_INPUT_IMAGE = 'pending-upload';

/** `/api/v1/video-models`, read model by model so one this build cannot parse does not hide the rest. */
export function parseVideoModels(body: unknown): VideoModel[] {
  const raw = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(model => {
    const parsed = VideoModelSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
}

function catalogEntry(id: string): VideoModelCapabilities | undefined {
  return (VIDEO_MODEL_IDS as readonly string[]).includes(id) ? VIDEO_MODEL_CATALOG[id as VideoModelId] : undefined;
}

/**
 * The server's description of a model in the shape the shared validator reads.
 *
 * Built from what the server sent rather than looked up locally, so a model the server added
 * after this build was cut is still validated against its real capabilities. Pricing is the
 * one part the public shape does not carry in USD, and the validator never reads it.
 */
export function capabilitiesOf(model: VideoModel): VideoModelCapabilities {
  const local = catalogEntry(model.id);
  return {
    provider: (local?.provider ?? model.provider) as VideoModelCapabilities['provider'],
    displayName: model.display_name,
    modes: model.modes,
    duration: model.duration,
    aspectRatios: model.aspect_ratios,
    resolutions: model.resolutions,
    defaults: {
      durationSeconds: model.defaults.duration_seconds,
      aspectRatio: model.defaults.aspect_ratio,
      resolution: model.defaults.resolution,
    },
    typicalRenderSeconds: local?.typicalRenderSeconds ?? 0,
    audio: model.audio,
    pricing: local?.pricing ?? { unit: 'per_second', usdByResolution: {} },
    defaultEnabled: true,
  };
}

/** One line per model, for the tool's description and for a refusal naming what is offered. */
export function describeVideoModel(model: VideoModel): string {
  const duration =
    model.duration.kind === 'range'
      ? `${model.duration.min}-${model.duration.max}s`
      : `${model.duration.values.join('/')}s`;
  const render = catalogEntry(model.id)?.typicalRenderSeconds;
  return (
    `${model.id} (${model.display_name}): ${model.modes.join(', ')}; duration ${duration}; ` +
    `aspect ${model.aspect_ratios.join(', ')}; resolution ${model.resolutions.join(', ')}` +
    (render ? `; renders in about ${render}s` : '')
  );
}

/**
 * Credits the job is expected to reserve, or null when neither side can price it.
 *
 * The shared estimateCost rules for any model this build knows - the same function the server
 * holds credits with, so the two agree. A model the server added later is priced from the
 * per-second credits it advertises, which can only round up against the real hold.
 */
export function estimateVideoCredits(model: VideoModel, request: VideoGenerationRequest): number | null {
  const local = catalogEntry(model.id);
  if (local) {
    try {
      return estimateVideoCostCredits(local, request);
    } catch {
      return null;
    }
  }
  const perSecond = model.credits_per_second?.[request.resolution];
  return perSecond === undefined ? null : Math.ceil(perSecond * request.durationSeconds);
}

/**
 * Which model to use. A named one the server does not offer is refused, with what it does offer,
 * rather than spent on a request that would 422 - the same rule as image models.
 */
export function resolveVideoModel(offered: readonly VideoModel[], requested: string | undefined): VideoModel {
  if (offered.length === 0) {
    throw new Error('This server offers no video-generation models, so there is nothing to generate with.');
  }
  if (requested) {
    const match = offered.find(model => model.id === requested);
    if (!match) {
      throw new Error(
        `This server does not offer the video model "${requested}". It offers: ${offered.map(model => model.id).join(', ')}.`
      );
    }
    return match;
  }
  return offered.find(model => model.id === PREFERRED_VIDEO_MODEL) ?? cheapestAtDefaults(offered);
}

function cheapestAtDefaults(offered: readonly VideoModel[]): VideoModel {
  let best = offered[0];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const model of offered) {
    const cost = estimateVideoCredits(model, defaultRequest(model)) ?? Number.POSITIVE_INFINITY;
    if (cost < bestCost) {
      best = model;
      bestCost = cost;
    }
  }
  return best;
}

function defaultRequest(model: VideoModel): VideoGenerationRequest {
  return {
    model: model.id as VideoModelId,
    mode: 'text_to_video',
    prompt: 'x',
    durationSeconds: model.defaults.duration_seconds,
    aspectRatio: model.defaults.aspect_ratio,
    resolution: model.defaults.resolution,
  };
}

export interface VideoSettings {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  /** Whether an input image will be attached, which makes this image-to-video. */
  withImage: boolean;
}

export interface VideoPlan {
  model: VideoModel;
  /** Validated against the model; `inputImageFileId` is filled in once the upload exists. */
  request: VideoGenerationRequest;
  estimatedCredits: number | null;
}

/**
 * Fill in the model's defaults and check the result with the shared validator.
 *
 * Never rounds or clamps, matching validateAgainstCapabilities: a 7s request to a model that
 * takes 4, 6 or 8 is refused with the allowed values, not quietly billed as 8.
 */
export function planVideoRequest(model: VideoModel, settings: VideoSettings): VideoPlan {
  const prompt = settings.prompt.trim();
  if (!prompt) throw new Error('The "prompt" argument is required.');
  if (prompt.length > VIDEO_PROMPT_MAX_LENGTH) {
    throw new Error(
      `The prompt is ${prompt.length} characters; video prompts may be at most ${VIDEO_PROMPT_MAX_LENGTH}.`
    );
  }
  const aspectRatio = settings.aspectRatio ?? model.defaults.aspect_ratio;
  if (!(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new Error(
      `"${aspectRatio}" is not an aspect ratio. ${model.display_name} allows: ${model.aspect_ratios.join(', ')}.`
    );
  }
  const resolution = settings.resolution ?? model.defaults.resolution;
  if (!(RESOLUTION_TIERS as readonly string[]).includes(resolution)) {
    throw new Error(
      `"${resolution}" is not a resolution. ${model.display_name} allows: ${model.resolutions.join(', ')}.`
    );
  }

  const request: VideoGenerationRequest = {
    model: model.id as VideoModelId,
    mode: settings.withImage ? 'image_to_video' : 'text_to_video',
    prompt,
    durationSeconds: settings.durationSeconds ?? model.defaults.duration_seconds,
    aspectRatio: aspectRatio as AspectRatio,
    resolution: resolution as ResolutionTier,
  };
  const checked = validateAgainstCapabilities(
    settings.withImage ? { ...request, inputImageFileId: PENDING_INPUT_IMAGE } : request,
    capabilitiesOf(model)
  );
  if (!checked.ok) throw new Error(`Cannot generate that video (${checked.code}): ${checked.message}.`);

  return { model, request, estimatedCredits: estimateVideoCredits(model, request) };
}

/** Rough render time from the shared catalog, for what the model is told to expect. */
export function typicalRenderSeconds(modelId: string): number | undefined {
  return catalogEntry(modelId)?.typicalRenderSeconds;
}
