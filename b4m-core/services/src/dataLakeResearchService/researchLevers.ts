import type { ResearchRunLevers } from '@bike4mind/common';
import {
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

/** Trim, dedupe, drop empties and cap the length of a user-supplied string list. */
const boundedStringList = (values: readonly unknown[] | undefined, max: number): string[] =>
  Array.from(
    new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0)
    )
  ).slice(0, max);

/**
 * Reduce one free-text list entry to the hostname `hostMatchesDomain` will compare against, or ''
 * when it cannot be one (dropped by the caller's `boundedStringList`).
 *
 * The field is a textarea whose placeholder is `example.net`, so what actually arrives is a mix of
 * `example.net`, `*.example.net`, `https://example.net/blog` and the occasional pasted URL with a
 * port or a trailing dot. Every spelling that does not reduce to a hostname fails OPEN on a deny
 * list (nothing matches, so nothing is blocked) and CLOSED on an allow list, silently, with nothing
 * telling the manager their rule did not take - the worst of the available failures on a
 * security-shaped list.
 *
 * Parsing rather than string-surgery is what makes that exhaustive: one `new URL` drops the scheme,
 * credentials, port, path and query, lowercases the host, punycodes an IDN so a Cyrillic entry can
 * match the `xn--` hostname a URL actually carries, and leaves a trailing root dot for us to strip
 * (`sourceHostname` strips it on the other side, so the two meet).
 */
const normalizeDomainEntry = (value: string): string => {
  const bare = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[*.]+/, '');
  if (!bare) return '';
  try {
    return new URL(`https://${bare}`).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
};

const normalizeDomainList = (values: readonly unknown[] | undefined): string[] =>
  boundedStringList(
    boundedStringList(values, RESEARCH_DOMAIN_LIST_MAX).map(normalizeDomainEntry),
    RESEARCH_DOMAIN_LIST_MAX
  );

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
    allowedDomains: normalizeDomainList(input.allowedDomains),
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
