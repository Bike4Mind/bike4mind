import { ModelInfo } from '@bike4mind/common';
import { isNewModel } from './aiSettingsUtils';

/**
 * Check if a model has an admin-configured rank override
 * (rank !== undefined and rank >= 0)
 */
const hasAdminRank = (model: ModelInfo): boolean => {
  return model.rank !== undefined && model.rank >= 0;
};

/** Unranked models sort after every ranked one rather than alongside rank 0. */
const rankOf = (model: ModelInfo): number => (hasAdminRank(model) ? (model.rank as number) : Number.MAX_SAFE_INTEGER);

/**
 * Order models the way the picker presents them, within a single provider group.
 *
 * 1. Newly released models, newest first - a launch is what people are looking for, and
 *    curation rarely catches up with it in time (Grok 4.5 shipped with no rank at all).
 * 2. Admin `rank`, ascending. This is deliberate curation ("new default workhorse tier"),
 *    so it outranks anything inferred.
 * 3. Release date, newest first. `rank` is a coarse tier rather than a total order - the two
 *    largest buckets hold over 40% of the catalog between them - so this tiebreak is what
 *    actually decides most of the visible order.
 * 4. Name, so the result is stable rather than dependent on catalog declaration order.
 *
 * Generic in T so callers get their own element type back, not a widened ModelInfo.
 */
export const sortModelsForPicker = <T extends ModelInfo>(models: T[]): T[] => {
  return [...models].sort((a, b) => {
    const aNew = isNewModel(a);
    const bNew = isNewModel(b);
    if (aNew !== bNew) return aNew ? -1 : 1;

    // Inside the new-release block date leads, so the single newest model is at the very top.
    // Curation waits its turn here: ranking by rank first buries a launch behind an older
    // model that merely sits in a better tier. Both are new, so both carry a releaseDate.
    if (aNew && bNew) {
      const newestFirst = (b.releaseDate as string).localeCompare(a.releaseDate as string);
      if (newestFirst !== 0) return newestFirst;
    }

    const rankDelta = rankOf(a) - rankOf(b);
    if (rankDelta !== 0) return rankDelta;

    // ISO YYYY-MM-DD, so a plain string compare is chronological. trainingCutoff is
    // deliberately not a fallback: it always predates release, so mixing the two would sink
    // every model that carries only a cutoff below every model that carries a release date.
    // Missing dates become '', which sorts last under a descending compare.
    const aReleased = a.releaseDate ?? '';
    const bReleased = b.releaseDate ?? '';
    if (aReleased !== bReleased) return bReleased.localeCompare(aReleased);

    return a.name.localeCompare(b.name);
  });
};
