import type { ModelInfo } from '../models';

// A plain string type, so a catalog-only record whose type this build cannot render still ranks.
type RankedModel = { type: string; name: string; rank?: number };

/** A rank someone set: the catalog's, or an admin's saved one (rank !== undefined and rank >= 0). */
export const hasAdminRank = (model: Pick<ModelInfo, 'rank'>): boolean => model.rank !== undefined && model.rank >= 0;

/**
 * Family key: the leading run of letters, so it survives the punctuation real names carry.
 * "GPT-5.4" and "gpt-6-astra" both key to "gpt"; splitting on whitespace instead keyed them
 * to "gpt-5.4" and to the whole raw id, and no two catalog models ever shared a cohort.
 */
const familyKey = (name: string): string => /^[a-z]+/i.exec(name.trim())?.[0]?.toLowerCase() ?? '';

/** Upper-middle element on an even cohort, which is the conservative half of a rank scale. */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/**
 * Rank for a model nobody has curated: the median of its same-type family, else of
 * its type section, else 1. Shared by the web picker (apps/client/app/utils/modelRanking.ts)
 * and the admin model list, so both show the same provisional rank.
 *
 * Median rather than minimum is deliberate. A discovery-introduced model can never
 * carry `rank` (feeds are forbidden from the presentation group), and taking the
 * minimum would let every such model claim its family's best tier - the "new release
 * goes to the top" behavior this module exists to remove.
 */
export const provisionalRank = <T extends RankedModel>(model: T, models: T[]): number => {
  const ranked = models.filter(hasAdminRank);

  const cohort = ranked.filter(m => m.type === model.type && familyKey(m.name) === familyKey(model.name));
  if (cohort.length > 0) return median(cohort.map(m => m.rank as number));

  const section = ranked.filter(m => m.type === model.type);
  if (section.length > 0) return median(section.map(m => m.rank as number));

  return 1;
};
