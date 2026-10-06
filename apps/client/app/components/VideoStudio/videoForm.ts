/**
 * The studio form's rules, kept free of React: defaults per model, what changes when the user switches model,
 * the request body, and the credit estimate. The server never rounds a request (validateAgainstCapabilities),
 * so the form is where values are moved onto what the model supports, and every move is reported to the user.
 */
import {
  estimateVideoCostCredits,
  VIDEO_MODEL_CATALOG,
  VideoModelIdSchema,
  type AspectRatio,
  type CreateVideoGenerationBody,
  type ResolutionTier,
  type VideoMode,
  type VideoModel,
} from '@bike4mind/common';

// Must match the prompt max in CreateVideoGenerationBodySchema (b4m-core/common/src/schemas/videoGenerations.ts).
export const VIDEO_PROMPT_MAX_LENGTH = 4000;

export type VideoInputImage = { fileId: string; fileName: string };

export type VideoFormState = {
  modelId: string;
  mode: VideoMode;
  prompt: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  resolution: ResolutionTier;
  // null unless the model's audio is 'optional'; the request then omits `audio` (the server rejects it otherwise).
  audio: boolean | null;
  inputImage: VideoInputImage | null;
};

export const MODE_LABELS: Record<VideoMode, string> = {
  text_to_video: 'Text to video',
  image_to_video: 'Image to video',
};

const lower = (mode: VideoMode): string => MODE_LABELS[mode].toLowerCase();

export function initialFormFor(model: VideoModel): VideoFormState {
  return {
    modelId: model.id,
    mode: model.modes.includes('text_to_video') ? 'text_to_video' : model.modes[0],
    prompt: '',
    durationSeconds: model.defaults.duration_seconds,
    aspectRatio: model.defaults.aspect_ratio,
    resolution: model.defaults.resolution,
    audio: model.audio === 'optional' ? true : null,
    inputImage: null,
  };
}

export function snapDuration(seconds: number, duration: VideoModel['duration']): number {
  if (duration.kind === 'discrete') {
    // Nearest allowed value; a tie goes to the shorter, cheaper clip.
    return duration.values.reduce((best, value) => {
      const distance = Math.abs(value - seconds);
      const bestDistance = Math.abs(best - seconds);
      return distance < bestDistance || (distance === bestDistance && value < best) ? value : best;
    });
  }
  const clamped = Math.min(Math.max(seconds, duration.min), duration.max);
  const snapped = duration.min + Math.round((clamped - duration.min) / duration.step) * duration.step;
  // Rounding up can step past max when (max - min) is not a whole number of steps.
  const inRange = snapped > duration.max ? snapped - duration.step : snapped;
  return Number(inRange.toFixed(6));
}

export function clampToModel(state: VideoFormState, model: VideoModel): { state: VideoFormState; changes: string[] } {
  const changes: string[] = [];
  const name = model.display_name;

  const mode = model.modes.includes(state.mode) ? state.mode : model.modes[0];
  if (mode !== state.mode) {
    changes.push(`${name} does not support ${lower(state.mode)}; switched to ${lower(mode)}.`);
  }

  const inputImage = mode === 'image_to_video' ? state.inputImage : null;
  if (state.inputImage && !inputImage) changes.push(`Removed the input image (${state.inputImage.fileName}).`);

  const durationSeconds = snapDuration(state.durationSeconds, model.duration);
  if (durationSeconds !== state.durationSeconds) {
    changes.push(`Duration changed from ${state.durationSeconds}s to ${durationSeconds}s.`);
  }

  const aspectRatio = model.aspect_ratios.includes(state.aspectRatio) ? state.aspectRatio : model.defaults.aspect_ratio;
  if (aspectRatio !== state.aspectRatio) {
    changes.push(`Aspect ratio changed from ${state.aspectRatio} to ${aspectRatio}.`);
  }

  const resolution = model.resolutions.includes(state.resolution) ? state.resolution : model.defaults.resolution;
  if (resolution !== state.resolution) {
    changes.push(`Resolution changed from ${state.resolution} to ${resolution}.`);
  }

  // A non-null audio means the previous model let the user choose; only then is a change worth reporting.
  const audio = model.audio === 'optional' ? (state.audio ?? true) : null;
  if (state.audio === false && model.audio === 'always') changes.push(`${name} always generates audio.`);
  if (state.audio === true && model.audio === 'none') changes.push(`${name} generates video without audio.`);

  return {
    state: { ...state, modelId: model.id, mode, inputImage, durationSeconds, aspectRatio, resolution, audio },
    changes,
  };
}

export function toCreateBody(state: VideoFormState): CreateVideoGenerationBody {
  return {
    model: state.modelId,
    prompt: state.prompt.trim(),
    mode: state.mode,
    duration_seconds: state.durationSeconds,
    aspect_ratio: state.aspectRatio,
    resolution: state.resolution,
    ...(state.mode === 'image_to_video' && state.inputImage && { input_image_file_id: state.inputImage.fileId }),
    ...(state.audio !== null && { audio: state.audio }),
  };
}

export function canSubmit(state: VideoFormState): boolean {
  const prompt = state.prompt.trim();
  if (prompt.length === 0 || prompt.length > VIDEO_PROMPT_MAX_LENGTH) return false;
  return state.mode !== 'image_to_video' || state.inputImage !== null;
}

/** The same estimate the server holds credits with (spec 11.5), or null when it cannot be computed. */
export function estimateCredits(state: VideoFormState): number | null {
  const model = VideoModelIdSchema.safeParse(state.modelId);
  if (!model.success) return null;
  try {
    return estimateVideoCostCredits(VIDEO_MODEL_CATALOG[model.data], {
      model: model.data,
      mode: state.mode,
      prompt: state.prompt,
      durationSeconds: state.durationSeconds,
      aspectRatio: state.aspectRatio,
      resolution: state.resolution,
    });
  } catch {
    // The catalog declares no price for this combination; the form shows "unavailable" rather than a wrong number.
    return null;
  }
}
