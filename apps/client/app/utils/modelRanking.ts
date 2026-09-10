import { ModelInfo } from '@bike4mind/common';

/**
 * Check if a model has an admin-configured rank override
 * (rank !== undefined and rank >= 0)
 */
const hasAdminRank = (model: ModelInfo): boolean => {
  return model.rank !== undefined && model.rank >= 0;
};

const firstWord = (name: string): string => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/**
 * Rank for a model nobody has curated: the median of its same-type family, else of
 * its type section, else 1.
 *
 * Median rather than minimum is deliberate. A discovery-introduced model can never
 * carry `rank` (feeds are forbidden from the presentation group), and taking the
 * minimum would let every such model claim its family's best tier - the "new release
 * goes to the top" behavior this module exists to remove.
 */
export const provisionalRank = <T extends ModelInfo>(model: T, models: T[]): number => {
  const ranked = models.filter(hasAdminRank);

  const cohort = ranked.filter(m => m.type === model.type && firstWord(m.name) === firstWord(model.name));
  if (cohort.length > 0) return median(cohort.map(m => m.rank as number));

  const section = ranked.filter(m => m.type === model.type);
  if (section.length > 0) return median(section.map(m => m.rank as number));

  return 1;
};

/**
 * Leading version token in a display name: "Claude 4.8 Opus" -> 4.8, "Llama 3 Instruct 70B" -> 3.
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
 * effective rank, then release date, then generation, then name.
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

    return a.name.localeCompare(b.name);
  });
};
