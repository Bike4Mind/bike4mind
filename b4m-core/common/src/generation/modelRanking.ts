/**
 * Per-request model ranking shared by every Studio medium (image/ranking.ts, video/ranking.ts, music/ranking.ts).
 * Pure and deterministic so web and mobile order the same list the same way: the medium adapters check each model
 * against its capability catalog with the server's own validator, and this module only orders the verdicts.
 */

// fits: can make the request as asked. mismatch: a value in the request is one it does not take (still pickable).
// unavailable: cannot run at all right now, whatever the request.
export const MODEL_FIT_STATUSES = ['fits', 'mismatch', 'unavailable'] as const;
export type ModelFitStatus = (typeof MODEL_FIT_STATUSES)[number];

// `code` is the validator's error code (the one the server answers with); `reason` its user-facing why-not.
export type ModelWhyNot = { code: string; reason: string };

// The code a caller-supplied unavailability reason carries, matching the job routes' answer for such a model.
export const MODEL_UNAVAILABLE_CODE = 'model_unavailable';

// How many models the picker shows before "Show all models".
export const RANKED_SHORTLIST_SIZE = 5;

// A model's quality class within its provider's line-up, best first. Not a price band: credits stay on every card.
export const MODEL_TIERS = ['flagship', 'standard', 'fast'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Where a model stands among its peers, declared on every catalog entry (image, video and music) and read only by
 * rankCandidates. `releasedAt` is the provider's general-availability date (YYYY-MM-DD); `preview` marks a model its
 * provider labels preview, which never ranks above a generally available one.
 */
export type ModelStanding = { tier: ModelTier; releasedAt: string; preview: boolean };

export type RankedModel<TId extends string = string> = {
  id: TId;
  status: ModelFitStatus;
  // Short phrases saying why the model suits this request, best first. Empty unless it fits.
  pickedFor: readonly string[];
  // Why it cannot make the request (mismatch) or cannot run (unavailable); null when it fits.
  whyNot: ModelWhyNot | null;
};

/**
 * Options every medium's ranker takes. `unavailable` maps a model id to why it cannot run right now (a provider not
 * wired, a retired id): knowledge the catalog does not hold, so the caller supplies it.
 */
export type ModelRankingOptions = {
  unavailable?: Readonly<Partial<Record<string, string>>>;
};

export type RankingCandidate<TId extends string> = {
  id: TId;
  // The first request value the model does not take, or null when it fits.
  mismatch: ModelWhyNot | null;
  // The model's own focus first, then each request signal it satisfies.
  pickedFor: readonly string[];
};

const STATUS_ORDER: Record<ModelFitStatus, number> = { fits: 0, mismatch: 1, unavailable: 2 };

// An id the bundled catalog does not know (a newer server) has no standing and ranks after every known model.
const compareStanding = (a: ModelStanding | undefined, b: ModelStanding | undefined): number => {
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1);
  return (
    Number(a.preview) - Number(b.preview) ||
    MODEL_TIERS.indexOf(a.tier) - MODEL_TIERS.indexOf(b.tier) ||
    // ISO dates compare as strings; newest first.
    b.releasedAt.localeCompare(a.releasedAt)
  );
};

const toRanked = <TId extends string>(
  candidate: RankingCandidate<TId>,
  unavailableReason: string | undefined
): RankedModel<TId> => {
  if (unavailableReason !== undefined) {
    return {
      id: candidate.id,
      status: 'unavailable',
      pickedFor: [],
      whyNot: { code: MODEL_UNAVAILABLE_CODE, reason: unavailableReason },
    };
  }
  if (candidate.mismatch) {
    return { id: candidate.id, status: 'mismatch', pickedFor: [], whyNot: candidate.mismatch };
  }
  return { id: candidate.id, status: 'fits', pickedFor: candidate.pickedFor, whyNot: null };
};

/**
 * Orders candidates, one rule for every medium: models that fit first, then the ones that do not take a value
 * (pickable, with the reason), then the ones that cannot run. Within a group: generally available before preview,
 * then by tier (flagship first), then newest release first, then the caller's order, so the result never depends on
 * sort stability or object key order.
 */
export const rankCandidates = <TId extends string>(
  candidates: readonly RankingCandidate<TId>[],
  standingOf: (id: string) => ModelStanding | undefined,
  options: ModelRankingOptions = {}
): RankedModel<TId>[] =>
  candidates
    .map((candidate, inputIndex) => ({
      ranked: toRanked(candidate, options.unavailable?.[candidate.id]),
      standing: standingOf(candidate.id),
      inputIndex,
    }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.ranked.status] - STATUS_ORDER[b.ranked.status] ||
        compareStanding(a.standing, b.standing) ||
        a.inputIndex - b.inputIndex
    )
    .map(({ ranked }) => ranked);

/** The "Picked for" line: the reasons joined, e.g. "product photoreal + reference". */
export const describePickedFor = (pickedFor: readonly string[]): string => pickedFor.join(' + ');
