/**
 * Create v2's music rules on top of musicForm: a model switch keeps every value, so each one the model does not take
 * is reported here with its why-not reason (musicFailureReason, the same text the server refuses with) and the value
 * the user can move to in one click. The model cards come from rankMusicModels, which runs the same validator.
 */
import {
  musicFailureReason,
  rankMusicModels,
  type MusicRankingRequest,
  type PublicMusicModel,
} from '@bike4mind/common';
import type { FieldProblem } from '@client/app/components/Studio/capabilityFields';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import {
  rankedCardFit,
  withRankedDefaultFirst,
  type StudioModelCard,
} from '@client/app/components/Studio/studioModelCard';
import { clampDuration, estimateCredits, initialFormFor, type MusicFormState } from './musicForm';

export type MusicProblemField = 'instrumental' | 'lyrics' | 'duration';

export type MusicFieldProblem = FieldProblem<Partial<MusicFormState>>;

export type MusicFieldProblems = Partial<Record<MusicProblemField, MusicFieldProblem>>;

const toDetailDuration = (duration: PublicMusicModel['duration']) =>
  duration.control === 'fixed'
    ? ({ control: 'fixed', seconds: duration.seconds } as const)
    : ({ control: duration.control, min: duration.min, max: duration.max, default: duration.default } as const);

/** Every form value `model` does not take, keyed by the field that holds it. Empty when the model fits. */
export function musicFieldProblems(model: PublicMusicModel, form: MusicFormState): MusicFieldProblems {
  const name = model.display_name;
  const problems: MusicFieldProblems = {};

  if (model.vocals === 'never' && !form.instrumental) {
    problems.instrumental = {
      reason: musicFailureReason({ model: name, code: 'unsupported_vocals' }),
      fixLabel: 'Make it instrumental',
      fix: { instrumental: true },
    };
  }

  // Lyrics the model would not sing are a value it does not take, not one to drop quietly at submit.
  if (model.lyrics === null && model.vocals !== 'never' && !form.instrumental && form.lyrics.trim().length > 0) {
    problems.lyrics = {
      reason: musicFailureReason({ model: name, code: 'unsupported_lyrics' }),
      fixLabel: 'Clear lyrics',
      fix: { lyrics: '' },
    };
  }

  const clamped = clampDuration(form.durationSeconds, model.duration);
  // null is "the model's own length", which every model takes.
  if (form.durationSeconds !== null && clamped !== form.durationSeconds) {
    problems.duration = {
      reason: musicFailureReason({
        model: name,
        code: 'unsupported_duration',
        requested: form.durationSeconds,
        allowed: toDetailDuration(model.duration),
      }),
      fixLabel: `Use ${model.duration.control === 'fixed' ? model.duration.seconds : clamped}s`,
      fix: { durationSeconds: clamped },
    };
  }

  return problems;
}

/** The form as the ranker reads it: lyrics only while the song has vocals, a length only when one is set. */
export const musicRankingRequest = (form: MusicFormState): MusicRankingRequest => {
  const lyrics = form.lyrics.trim();
  return {
    instrumental: form.instrumental,
    ...(!form.instrumental && lyrics.length > 0 && { lyrics }),
    ...(form.durationSeconds !== null && { durationSeconds: form.durationSeconds }),
  };
};

/**
 * A card per music model in rankMusicModels order for the form: the ones that fit first with why they were picked,
 * the rest after with the validator's why-not reason. Each is priced at its own default length.
 */
export const musicModelCards = (models: readonly PublicMusicModel[], form: MusicFormState): StudioModelCard[] => {
  const byId = new Map(models.map(model => [model.id, model]));
  return rankMusicModels([...byId.keys()], musicRankingRequest(form)).flatMap(ranked => {
    const model = byId.get(ranked.id);
    if (!model) return [];
    return [
      {
        id: model.id,
        name: model.display_name,
        provider: model.provider_label ?? model.provider,
        strength: model.blurb ?? '',
        creditsPerOutput: estimateCredits(initialFormFor(model)),
        outputNoun: 'song',
        ...rankedCardFit(ranked),
      },
    ];
  });
};

/** `models` with the ranked default first, so Create v2 opens on it (see withRankedDefaultFirst). */
export const withRankedMusicDefaultFirst = (models: NonEmptyList<PublicMusicModel>): NonEmptyList<PublicMusicModel> =>
  withRankedDefaultFirst(models, model => musicModelCards(models, initialFormFor(model)));
