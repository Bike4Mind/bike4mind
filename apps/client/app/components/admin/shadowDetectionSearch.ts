import {
  SHADOW_DETECTION_VERDICTS,
  SHADOW_DETECTORS,
  type ShadowDetectionListQuery,
  type ShadowDetectionVerdict,
  type ShadowDetector,
} from '@bike4mind/common';

// The page has no free-text search; query and view are declared only because the list URL state needs them.
export const SHADOW_DETECTION_SEARCH_KEYS = {
  query: 'detectionQuery',
  view: 'detectionView',
  filters: { detector: 'detectionDetector', verdict: 'detectionVerdict' },
} as const;
export const SHADOW_DETECTION_TAB_PARAMS = Object.values(SHADOW_DETECTION_SEARCH_KEYS.filters);

/** The verdict filter value that lists every detection; an absent filter means Unreviewed. */
export const ALL_VERDICTS_FILTER = 'all';

export type VerdictFilter = ShadowDetectionVerdict | 'unreviewed' | typeof ALL_VERDICTS_FILTER;

const isDetector = (value: string): value is ShadowDetector => (SHADOW_DETECTORS as readonly string[]).includes(value);
const isVerdict = (value: string): value is ShadowDetectionVerdict =>
  (SHADOW_DETECTION_VERDICTS as readonly string[]).includes(value);

/** Reads the URL filters; an unknown value falls back to the default rather than reaching the API. */
export function readShadowDetectionFilters(filters: Record<string, string>): {
  detector: ShadowDetector | undefined;
  verdict: VerdictFilter;
} {
  const detector = filters.detector ?? '';
  const verdict = filters.verdict ?? '';
  return {
    detector: isDetector(detector) ? detector : undefined,
    verdict: verdict === ALL_VERDICTS_FILTER || isVerdict(verdict) ? verdict : 'unreviewed',
  };
}

export const toListQuery = (
  detector: ShadowDetector | undefined,
  verdict: VerdictFilter
): ShadowDetectionListQuery => ({
  detector,
  verdict: verdict === ALL_VERDICTS_FILTER ? undefined : verdict,
});
