import { describePickedFor, type RankedModel } from '@bike4mind/common';

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
  // What the model can do, e.g. "Generate", "Edit".
  modes: readonly string[];
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
