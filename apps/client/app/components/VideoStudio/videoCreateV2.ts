/**
 * Create v2's video rules on top of videoForm: a model switch keeps every value, so each one the model does not take
 * is reported here with its why-not reason (videoFailureReason, the same text the server refuses with) and the value
 * the user can move to in one click. The model cards read the same problems to grey out the models that do not fit.
 */
import { rankVideoModels, videoFailureReason, type VideoModel, type VideoRankingRequest } from '@bike4mind/common';
import type { FieldProblem } from '@client/app/components/Studio/capabilityFields';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { rankedCardFit, type StudioModelCard } from '@client/app/components/Studio/studioModelCard';
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

// The ranker checks capability, not the file, so an image not chosen yet still ranks as "this animates an image".
const PENDING_FIRST_FRAME = 'pending-first-frame';

/** The form as the ranker reads it. Audio is left out: it is a per-model toggle, not part of what is asked for. */
export const videoRankingRequest = (form: VideoFormState): VideoRankingRequest => ({
  mode: form.mode,
  durationSeconds: form.durationSeconds,
  aspectRatio: form.aspectRatio,
  resolution: form.resolution,
  ...(form.mode === 'image_to_video' && {
    inputs: [{ role: 'first_frame' as const, fileId: form.inputImage?.fileId ?? PENDING_FIRST_FRAME }],
  }),
});

/**
 * A card per video model in rankVideoModels order for the form: the ones that fit first with why they were picked,
 * the rest after with the validator's why-not reason. Each is priced at its own defaults.
 */
export const videoModelCards = (models: readonly VideoModel[], form: VideoFormState): StudioModelCard[] => {
  const byId = new Map(models.map(model => [model.id, model]));
  return rankVideoModels([...byId.keys()], videoRankingRequest(form)).flatMap(ranked => {
    const model = byId.get(ranked.id);
    if (!model) return [];
    return [
      {
        id: model.id,
        name: model.display_name,
        provider: model.provider_label ?? model.provider,
        strength: model.blurb ?? '',
        creditsPerOutput: estimateCredits(initialFormFor(model)),
        outputNoun: 'clip',
        modes: model.modes.map(mode => MODE_LABELS[mode]),
        ...rankedCardFit(ranked),
      },
    ];
  });
};

/** `models` with the ranker's pick for a fresh form first, so Create v2 opens on it (the form state opens on [0]). */
export const withRankedDefaultFirst = (models: NonEmptyList<VideoModel>): NonEmptyList<VideoModel> => {
  const pick = videoModelCards(models, initialFormFor(models[0])).find(card => card.unavailableReason === null);
  const first = models.find(model => model.id === pick?.id);
  return first ? [first, ...models.filter(model => model !== first)] : models;
};
