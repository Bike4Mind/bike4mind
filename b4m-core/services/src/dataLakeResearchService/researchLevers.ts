import type { ResearchRunLevers } from '@bike4mind/common';
import {
  boundedStringList,
  deriveLegacyAllowedDomains,
  isResearchUnlistedSources,
  normalizeDomainList,
  upgradeLegacyResearchLevers,
  RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
  RESEARCH_COST_CEILING_MICRO_USD_LIMIT,
  RESEARCH_CONFIG_QUERY_MAX_CHARS,
  RESEARCH_DOMAIN_LIST_MAX,
  RESEARCH_MAX_PROPOSALS_DEFAULT,
  RESEARCH_MAX_PROPOSALS_LIMIT,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MAX_RESULTS_LIMIT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
  RESEARCH_RECENCY_DAYS_LIMIT,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

/**
 * The one place a lever's stored value is turned into the value a run will actually use (#1682).
 *
 * Normalization happens HERE rather than at the route, and the run loop reads only the output of
 * this function, so there is exactly one answer to "what does this config mean". A route-only clamp
 * would leave a config written before a bound tightened - or by a direct DB edit, or by a future
 * second write path - running unclamped, which on `costCeilingMicroUsd` and `maxProposals` is the
 * difference between a lever and a suggestion.
 *
 * Every bound WIDENS to a default or CLAMPS to a limit rather than throwing, with one exception:
 * an empty query, which has no sane substitute and is refused. Rejecting the rest would turn a
 * tightened bound into a config that can no longer be opened, let alone fixed.
 */

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(parsed, min), max);
};

/** 0..1, clamped. A non-number falls back to the default rather than to 0 ("propose everything"). */
const clampUnitInterval = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
};

/**
 * What a caller may hand in. `recencyDays` and `model` accept null as well as absent, because those
 * are the two fields a user can CLEAR: the UI sends null for an emptied field, and the stored
 * document holds null for an unset one, so both spellings have to arrive here rather than at three
 * separate call sites that each remember to translate.
 */
export type ResearchLeversDraft = Partial<Omit<ResearchRunLevers, 'recencyDays' | 'model'>> & {
  recencyDays?: number | null;
  model?: string | null;
};

export function normalizeResearchLevers(input: ResearchLeversDraft): ResearchRunLevers {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new BadRequestError('A research run needs a question to research');

  const recencyDays = clampInt(input.recencyDays, 0, 0, RESEARCH_RECENCY_DAYS_LIMIT);

  // Legacy `allowedDomains` is normalized BEFORE the upgrade so emptiness is judged on what the
  // filter will actually use: a list like `*.` normalizes to nothing and stays unrestricted.
  // A stored `unlistedSources` that is not a valid value fails closed on the tier lists.
  const trustedDomains = normalizeDomainList(input.trustedDomains);
  const reviewDomains = normalizeDomainList(input.reviewDomains);
  const rawUnlisted: unknown = input.unlistedSources;
  const unlistedSources =
    rawUnlisted === undefined || rawUnlisted === null
      ? // Neither shape given: nothing restricts the run, and the upgrade must not read it as legacy.
        input.allowedDomains === undefined
        ? 'review'
        : undefined
      : isResearchUnlistedSources(rawUnlisted)
        ? rawUnlisted
        : trustedDomains.length + reviewDomains.length > 0
          ? 'drop'
          : 'review';
  const tiers = upgradeLegacyResearchLevers({
    ...input,
    query,
    trustedDomains,
    reviewDomains,
    unlistedSources: unlistedSources as ResearchRunLevers['unlistedSources'] | undefined,
    allowedDomains: input.allowedDomains === undefined ? undefined : normalizeDomainList(input.allowedDomains),
  } as Parameters<typeof upgradeLegacyResearchLevers>[0]);
  const tierFields = {
    trustedDomains: tiers.trustedDomains,
    reviewDomains: tiers.reviewDomains,
    unlistedSources: tiers.unlistedSources,
  };

  return {
    query: query.slice(0, RESEARCH_CONFIG_QUERY_MAX_CHARS),
    // Left exactly as given, including absent: the run resolves the model against the deployment's
    // live catalog, which is the only place that knows whether it is still available.
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    maxResults: clampInt(input.maxResults, RESEARCH_MAX_RESULTS_DEFAULT, 1, RESEARCH_MAX_RESULTS_LIMIT),
    maxProposals: clampInt(input.maxProposals, RESEARCH_MAX_PROPOSALS_DEFAULT, 1, RESEARCH_MAX_PROPOSALS_LIMIT),
    // 0 is the storable spelling of "no recency constraint"; it becomes absent so the search call
    // and the UI both see one representation of it instead of two.
    ...(recencyDays > 0 ? { recencyDays } : {}),
    ...tierFields,
    allowedDomains: deriveLegacyAllowedDomains(tierFields),
    blockedDomains: normalizeDomainList(input.blockedDomains),
    minRelevance: clampUnitInterval(input.minRelevance, RESEARCH_MIN_RELEVANCE_DEFAULT),
    costCeilingMicroUsd: clampInt(
      input.costCeilingMicroUsd,
      RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
      // Floor of 1, not 0: a ceiling of 0 is a run that can never judge anything, which reads to a
      // user as "research is broken" rather than as the setting they chose.
      1,
      RESEARCH_COST_CEILING_MICRO_USD_LIMIT
    ),
    // Not sanitized for the reserved `datalake:` namespace here - `proposeDataLakeContent` strips
    // those at the queue door, and duplicating the rule is how the two copies drift.
    proposedTags: boundedStringList(input.proposedTags, RESEARCH_DOMAIN_LIST_MAX),
  };
}
