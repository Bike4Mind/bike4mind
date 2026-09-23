/**
 * How a detected corpus problem reads to the curator reviewing it (#3044).
 *
 * The detector's vocabulary is a rule name (`metric-disagreement`), which is the right key and the
 * wrong label. Kept out of the component so the wording is one place both the filter control and
 * the list row read from - two spellings of the same kind would look like two different kinds.
 *
 * Every hint below is hedged on purpose. These rules are recall-oriented patterns over prose, so a
 * finding means "worth a human's eye", never "proven contradiction" - the surface must not promise
 * more than the detector can support, and this copy is where that promise is actually made.
 */

import type { IDataLakeFinding, InconsistencyKind, LakeFindingDetector, LakeFindingStatus } from '@bike4mind/common';

export const FINDING_KIND_LABEL: Record<InconsistencyKind, string> = {
  'superlative-conflict': 'Competing claims',
  'metric-disagreement': 'Numbers disagree',
  'relationship-conflict': 'Relationship conflict',
  'expired-claim': 'Expired claim',
};

export const FINDING_KIND_HINT: Record<InconsistencyKind, string> = {
  'superlative-conflict': 'Two documents each claim to be the only or the best at the same thing.',
  'metric-disagreement': 'The same labelled metric is stated with different numbers.',
  'relationship-conflict':
    'The same organization is described as a customer in one document and a prospect in another.',
  'expired-claim': 'A dated claim whose year has already passed.',
};

export const FINDING_STATUS_LABEL: Record<LakeFindingStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const FINDING_DETECTOR_LABEL: Record<LakeFindingDetector, string> = {
  lexical: 'Pattern match',
  model: 'Reading pass',
};

/**
 * Whether a finding a curator already closed is still being detected.
 *
 * `lastSeenAt` advances monotonically and `resolvedAt` never moves, so the comparison is the model's
 * own recurrence signal rather than a guess - a resolved problem the detector keeps seeing stays
 * resolved-and-recurring instead of reopening under the curator who closed it, which means the list
 * is the only place that difference can be seen at all.
 */
export function hasRecurredSinceResolution(finding: Pick<IDataLakeFinding, 'lastSeenAt' | 'resolvedAt'>): boolean {
  if (!finding.resolvedAt) return false;
  const resolved = new Date(finding.resolvedAt).getTime();
  const lastSeen = new Date(finding.lastSeenAt).getTime();
  if (Number.isNaN(resolved) || Number.isNaN(lastSeen)) return false;
  return lastSeen > resolved;
}

/** Dates arrive from the API as ISO strings despite the `Date` in the type. Both are accepted. */
export function formatFindingDate(value: Date | string | null | undefined): string {
  if (!value) return 'unknown';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
