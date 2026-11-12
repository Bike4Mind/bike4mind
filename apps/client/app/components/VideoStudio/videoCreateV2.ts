/**
 * Create v2's video rules on top of videoForm: a model switch keeps every value, so each one the model does not take
 * is reported here with its why-not reason (videoFailureReason, the same text the server refuses with) and the value
 * the user can move to in one click. The model cards read the same problems to grey out the models that do not fit.
 */
import {
  VIDEO_MODEL_STRENGTHS,
  VIDEO_PROVIDER_LABELS,
  VIDEO_PROVIDER_IDS,
  VideoModelIdSchema,
  videoFailureReason,
  type VideoModel,
  type VideoProviderId,
} from '@bike4mind/common';
import type { FieldProblem } from '@client/app/components/Studio/capabilityFields';
import type { StudioModelCard } from '@client/app/components/Studio/StudioModelCards';
import { MODE_LABELS, estimateCredits, initialFormFor, snapDuration, type VideoFormState } from './videoForm';

export type VideoProblemField = 'mode' | 'duration' | 'aspect' | 'resolution';

export type VideoFieldProblem = FieldProblem<Partial<VideoFormState>>;

export type VideoFieldProblems = Partial<Record<VideoProblemField, VideoFieldProblem>>;

/** Every form value `model` does not take, keyed by the field that holds it. Empty when the model fits. */
export function videoFieldProblems(model: VideoModel, form: VideoFormState): VideoFieldProblems {
  const name = model.display_name;
  const problems: VideoFieldProblems = {};

  if (!model.modes.includes(form.mode)) {
    const mode = model.modes[0];
    problems.mode = {
      reason: videoFailureReason({ model: name, code: 'unsupported_mode', mode: form.mode }),
      fixLabel: `Use ${MODE_LABELS[mode].toLowerCase()}`,
      fix: { mode, inputImage: null },
    };
  }

  const snapped = snapDuration(form.durationSeconds, model.duration);
  if (snapped !== form.durationSeconds) {
    problems.duration = {
      reason: videoFailureReason({
        model: name,
        code: 'unsupported_duration',
        requested: form.durationSeconds,
        allowed: model.duration,
      }),
      fixLabel: `Use ${snapped}s`,
      fix: { durationSeconds: snapped },
    };
  }

  if (!model.aspect_ratios.includes(form.aspectRatio)) {
    problems.aspect = {
      reason: videoFailureReason({
        model: name,
        code: 'unsupported_aspect_ratio',
        requested: form.aspectRatio,
        allowed: model.aspect_ratios,
      }),
      fixLabel: `Use ${model.defaults.aspect_ratio}`,
      fix: { aspectRatio: model.defaults.aspect_ratio },
    };
  }

  if (!model.resolutions.includes(form.resolution)) {
    problems.resolution = {
      reason: videoFailureReason({
        model: name,
        code: 'unsupported_resolution',
        requested: form.resolution,
        allowed: model.resolutions,
      }),
      fixLabel: `Use ${model.defaults.resolution}`,
      fix: { resolution: model.defaults.resolution },
    };
  }

  return problems;
}

const isVideoProvider = (provider: string): provider is VideoProviderId =>
  (VIDEO_PROVIDER_IDS as readonly string[]).includes(provider);

const strengthOf = (modelId: string): string => {
  const parsed = VideoModelIdSchema.safeParse(modelId);
  return parsed.success ? VIDEO_MODEL_STRENGTHS[parsed.data] : '';
};

/** A card per video model, each priced at its own defaults and greyed with the first value it does not take. */
export const videoModelCards = (models: readonly VideoModel[], form: VideoFormState): StudioModelCard[] =>
  models.map(model => {
    const [firstProblem] = Object.values(videoFieldProblems(model, form));
    return {
      id: model.id,
      name: model.display_name,
      provider: isVideoProvider(model.provider) ? VIDEO_PROVIDER_LABELS[model.provider] : model.provider,
      strength: strengthOf(model.id),
      creditsPerOutput: estimateCredits(initialFormFor(model)),
      outputNoun: 'clip',
      modes: model.modes.map(mode => MODE_LABELS[mode]),
      unavailableReason: null,
      mismatchReason: firstProblem?.reason ?? null,
    };
  });
