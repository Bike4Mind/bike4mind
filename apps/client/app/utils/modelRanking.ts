import { hasAdminRank, provisionalRank, type ModelInfo } from '@bike4mind/common';

export { provisionalRank };

/**
 * Leading version token in a display name: "Claude Opus 4.8" -> 4.8, "Llama 3 Instruct 70B" -> 3.
 * -1 sorts a versionless name last.
 *
 * The FIRST number, not the last: parameter counts and variant suffixes trail the version
 * ("Gemini 1.5 Flash 8B", "Claude 3.5 Sonnet V2"), and a discovery-introduced model is named
 * by its raw id, so a trailing date ("claude-sonnet-5-20260401") would read as generation 20260401.
 */
const derivedGeneration = (name: string): number => {
  const matches = name.match(/\d+(?:\.\d+)?/g);
  return matches ? Number(matches[0]) : -1;
};

/**
 * Order models as the picker presents them, within one provider group:
 * effective rank, then release date, then generation, then name, then id.
 *
 * Id is last because it has to be: a model served by two backends is authored twice under
 * one display name with the same rank and release date (14 such twins in the seed today),
 * so without it the comparator is not total and those pairs fall back to input order.
 *
 * Generation must stay below rank and date. Promoting it reintroduces the bug this
 * replaces, where a same-family point release outranks its generation's flagship.
 * `isNewModel` and its badge are informational only and do not affect this order.
 */
export const sortModelsForPicker = <T extends ModelInfo>(models: T[]): T[] => {
  // Once per call, not per comparison: a cohort median re-derived from the whole
  // array on every pair is O(n^2 log n) and not guaranteed consistent.
  const effectiveRanks = new Map<string, number>();
  models.forEach(model => {
    effectiveRanks.set(model.id, hasAdminRank(model) ? (model.rank as number) : provisionalRank(model, models));
  });

  return [...models].sort((a, b) => {
    const rankDelta = (effectiveRanks.get(a.id) as number) - (effectiveRanks.get(b.id) as number);
    if (rankDelta !== 0) return rankDelta;

    // trainingCutoff is deliberately not a fallback here: it always predates release, so
    // mixing the two sinks every cutoff-only model below every dated one.
    const aReleased = a.releaseDate ?? '';
    const bReleased = b.releaseDate ?? '';
    if (aReleased !== bReleased) return bReleased.localeCompare(aReleased);

    const generationDelta = derivedGeneration(b.name) - derivedGeneration(a.name);
    if (generationDelta !== 0) return generationDelta;

    const nameDelta = a.name.localeCompare(b.name);
    if (nameDelta !== 0) return nameDelta;

    return a.id.localeCompare(b.id);
  });
};
