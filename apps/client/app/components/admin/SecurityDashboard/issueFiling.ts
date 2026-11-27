import type { SecopsTriageRunSummary, SecopsTriageStatusResponse } from '@client/pages/api/admin/secops-triage/status';
import type { SecurityScan } from '../securityDashboardSearch';

type RepoCheck = NonNullable<SecopsTriageStatusResponse['github']['check']>;
export type RepoIssue = Extract<RepoCheck, { ok: false }>['reason'];

/**
 * The scan source each scan's findings are filed under, as published to the triage queue by the
 * security-dashboard ingest routes. Cloud baseline and Prowler both publish as 'cloud'.
 */
export const FILING_SOURCE_BY_SCAN: Readonly<Record<SecurityScan, string>> = {
  web: 'web-owasp',
  cloud: 'cloud',
  prowler: 'cloud',
  'active-defense': 'active-defense',
};

const SCAN_SOURCE_LABELS: Readonly<Record<string, string>> = {
  'web-owasp': 'Website',
  cloud: 'Cloud baseline or Prowler',
  'active-defense': 'Active defense',
  secrets: 'Secrets',
  packages: 'Packages',
  'code-semgrep': 'Code',
};

export const scanSourceLabel = (source: string): string =>
  Object.hasOwn(SCAN_SOURCE_LABELS, source) ? SCAN_SOURCE_LABELS[source] : source;

export const REPO_ISSUE_LABELS: Readonly<Record<RepoIssue, string>> = {
  not_configured: 'Not set',
  not_allowed: "Not in the connection's allowed repositories",
  not_found: 'Not found',
  public: 'Public (must be private)',
  archived: 'Archived (read-only)',
  issues_disabled: 'Issues disabled',
};

// Keys are the worker's skip reasons: its own early returns plus every repository check reason.
const SKIP_REASONS: Readonly<Record<string, string>> = {
  disabled: 'triage is disabled',
  invalid_config: 'the saved configuration is invalid',
  no_github_connection: 'there is no GitHub connection',
  not_configured: 'no repository is set',
  not_allowed: "the repository is not in the connection's allowed repositories",
  not_found: 'the repository was not found',
  public: 'the repository is public',
  archived: 'the repository is archived',
  issues_disabled: 'issues are disabled on the repository',
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const skipped = (run: SecopsTriageRunSummary) =>
  `Skipped: ${(run.reason && Object.hasOwn(SKIP_REASONS, run.reason) && SKIP_REASONS[run.reason]) || run.reason || 'no reason was recorded'}`;

/** One plain line per run, e.g. "1 finding, 1 below threshold, 0 created" or "Skipped: triage is disabled". */
export function describeTriageRun(run: SecopsTriageRunSummary): string {
  if (run.status === 'failed') return `Failed: ${run.error || 'no error message was recorded'}`;
  if (run.status === 'skipped') return skipped(run);
  const parts = [plural(run.findingCount, 'finding')];
  const counts = run.counts;
  if (counts) {
    parts.push(`${counts.belowThreshold} below threshold`, `${counts.created} created`);
    if (counts.updated) parts.push(`${counts.updated} updated`);
    if (counts.reopened) parts.push(`${counts.reopened} reopened`);
    if (counts.closed) parts.push(`${counts.closed} closed`);
    if (counts.suppressed) parts.push(`${counts.suppressed} left closed`);
    if (counts.overCap) parts.push(`${counts.overCap} over the per-scan cap`);
  }
  return `${run.dryRun ? 'Dry run: ' : ''}${parts.join(', ')}`;
}

/** What a run did to issues, short enough for a table cell, e.g. "2 created, 1 closed" or "No issue changes". */
export function describeIssueOutcome(run: SecopsTriageRunSummary): string {
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'skipped') return skipped(run);
  const counts = run.counts;
  const parts = counts
    ? (['created', 'updated', 'reopened', 'closed'] as const)
        .filter(key => counts[key] > 0)
        .map(key => `${counts[key]} ${key}`)
    : [];
  return `${run.dryRun ? 'Dry run: ' : ''}${parts.length > 0 ? parts.join(', ') : 'No issue changes'}`;
}

/** The newest filing run for a scan, or undefined when its source has none. */
export const latestFilingRun = (
  runs: readonly SecopsTriageRunSummary[],
  scan: SecurityScan
): SecopsTriageRunSummary | undefined => runs.find(run => run.scanSource === FILING_SOURCE_BY_SCAN[scan]);
