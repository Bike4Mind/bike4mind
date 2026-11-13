import { describePickedFor, type RankedModel } from '@bike4mind/common';
import type { NonEmptyList } from './useCapabilityFormState';

/** One model as the Studio model picker (StudioModelPicker) shows it, in its medium ranker's order. */
export type StudioModelCard = {
  id: string;
  name: string;
  provider: string;
  strength: string;
  // Indicative credits for one output (each medium says at which settings), or null when it cannot be priced.
  creditsPerOutput: number | null;
  // What one output is called, mid-sentence: "image", "clip", "song".
  outputNoun: string;
  // The "Picked for" line from the ranker's reasons, e.g. "product photoreal + reference"; null unless it fits.
  pickedFor: string | null;
  // The validator's code for the reason below (the one the server answers with), or null when it fits.
  whyNotCode: string | null;
  // The model cannot run at all right now, so it cannot be picked.
  unavailableReason: string | null;
  // The model cannot make the current request. Still pickable: picking it marks the controls that do not fit.
  mismatchReason: string | null;
};

/** The fit fields of a card, read from one ranker verdict (rankImageModels / rankVideoModels / rankMusicModels). */
export const rankedCardFit = (
  ranked: RankedModel
): Pick<StudioModelCard, 'pickedFor' | 'whyNotCode' | 'unavailableReason' | 'mismatchReason'> => ({
  pickedFor: ranked.status === 'fits' ? describePickedFor(ranked.pickedFor) : null,
  whyNotCode: ranked.whyNot?.code ?? null,
  unavailableReason: ranked.status === 'unavailable' ? (ranked.whyNot?.reason ?? null) : null,
  mismatchReason: ranked.status === 'mismatch' ? (ranked.whyNot?.reason ?? null) : null,
});

const pickableIds = (cards: readonly StudioModelCard[]): string[] =>
  cards.filter(card => card.unavailableReason === null).map(card => card.id);

/**
 * `models` with the ranked default first, so Create v2 opens on it (the form state opens on [0]). The default is the
 * first pickable model that also ranks first against its own fresh form, so the row and the top of the panel agree
 * whatever order the server listed the models in. `cardsFor` ranks every model against `model`'s fresh form.
 */
export const withRankedDefaultFirst = <TModel extends { id: string }>(
  models: NonEmptyList<TModel>,
  cardsFor: (model: TModel) => readonly StudioModelCard[]
): NonEmptyList<TModel> => {
  const byId = new Map(models.map(model => [model.id, model]));
  const candidates = pickableIds(cardsFor(models[0]))
    .map(id => byId.get(id))
    .filter((model): model is TModel => model !== undefined);
  const first = candidates.find(model => pickableIds(cardsFor(model))[0] === model.id) ?? candidates[0];
  return first ? [first, ...models.filter(model => model !== first)] : models;
};
