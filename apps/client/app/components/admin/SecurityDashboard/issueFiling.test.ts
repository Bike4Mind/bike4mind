import { describe, expect, it } from 'vitest';
import type { SecopsTriageRunSummary } from '@client/pages/api/admin/secops-triage/status';
import { describeIssueOutcome, describeTriageRun, latestFilingRun, scanSourceLabel } from './issueFiling';

const counts = { created: 0, updated: 0, reopened: 0, closed: 0, suppressed: 0, belowThreshold: 0, overCap: 0 };
const run = (overrides: Partial<SecopsTriageRunSummary> = {}): SecopsTriageRunSummary => ({
  scanSource: 'web-owasp',
  status: 'completed',
  dryRun: false,
  findingCount: 1,
  startedAt: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

describe('describeTriageRun', () => {
  it('summarises a completed run, adding only the non-zero extra counts', () => {
    expect(describeTriageRun(run({ counts: { ...counts, belowThreshold: 1 } }))).toBe(
      '1 finding, 1 below threshold, 0 created'
    );
    expect(
      describeTriageRun(
        run({
          findingCount: 6,
          counts: { ...counts, created: 1, updated: 1, reopened: 1, closed: 1, suppressed: 1, overCap: 1 },
        })
      )
    ).toBe(
      '6 findings, 0 below threshold, 1 created, 1 updated, 1 reopened, 1 closed, 1 left closed, 1 over the per-scan cap'
    );
    expect(describeTriageRun(run({ dryRun: true, counts }))).toBe('Dry run: 1 finding, 0 below threshold, 0 created');
  });

  it.each([
    ['disabled', 'Skipped: triage is disabled'],
    ['invalid_config', 'Skipped: the saved configuration is invalid'],
    ['no_github_connection', 'Skipped: there is no GitHub connection'],
    ['not_configured', 'Skipped: no repository is set'],
    ['not_allowed', "Skipped: the repository is not in the connection's allowed repositories"],
    ['not_found', 'Skipped: the repository was not found'],
    ['archived', 'Skipped: the repository is archived'],
    ['public', 'Skipped: the repository is public'],
    ['issues_disabled', 'Skipped: issues are disabled on the repository'],
  ])('explains a run skipped for %s', (reason, text) => {
    expect(describeTriageRun(run({ status: 'skipped', reason }))).toBe(text);
  });

  it('shows an unknown skip reason as stored, and says when none was recorded', () => {
    expect(describeTriageRun(run({ status: 'skipped', reason: 'something_new' }))).toBe('Skipped: something_new');
    expect(describeTriageRun(run({ status: 'skipped', reason: 'constructor' }))).toBe('Skipped: constructor');
    expect(describeTriageRun(run({ status: 'skipped' }))).toBe('Skipped: no reason was recorded');
  });

  it('shows the error of a failed run', () => {
    expect(describeTriageRun(run({ status: 'failed', error: 'rate limited' }))).toBe('Failed: rate limited');
    expect(describeTriageRun(run({ status: 'failed' }))).toBe('Failed: no error message was recorded');
  });
});

describe('describeIssueOutcome', () => {
  it('lists only the issue changes a run made', () => {
    expect(describeIssueOutcome(run({ counts: { ...counts, created: 2, closed: 1, suppressed: 3, overCap: 4 } }))).toBe(
      '2 created, 1 closed'
    );
    expect(describeIssueOutcome(run({ counts: { ...counts, updated: 1, reopened: 1 } }))).toBe('1 updated, 1 reopened');
  });

  it('says when a run changed no issues, and marks a dry run', () => {
    expect(describeIssueOutcome(run({ counts }))).toBe('No issue changes');
    expect(describeIssueOutcome(run())).toBe('No issue changes');
    expect(describeIssueOutcome(run({ dryRun: true, counts: { ...counts, created: 1 } }))).toBe('Dry run: 1 created');
  });

  it('keeps a failure short and gives the skip reason', () => {
    expect(describeIssueOutcome(run({ status: 'failed', error: 'a long provider error' }))).toBe('Failed');
    expect(describeIssueOutcome(run({ status: 'skipped', reason: 'disabled' }))).toBe('Skipped: triage is disabled');
  });
});

describe('latestFilingRun', () => {
  const runs = [
    run({ scanSource: 'cloud', startedAt: '2026-11-17T12:00:00.000Z' }),
    run({ scanSource: 'web-owasp', startedAt: '2026-11-17T11:00:00.000Z' }),
    run({ scanSource: 'web-owasp', startedAt: '2026-11-17T10:00:00.000Z' }),
  ];

  it('picks the newest run of the scan source the scan files under', () => {
    expect(latestFilingRun(runs, 'web')?.startedAt).toBe('2026-11-17T11:00:00.000Z');
  });

  it('gives cloud baseline and Prowler the same run, since both file as cloud', () => {
    expect(latestFilingRun(runs, 'cloud')).toBe(runs[0]);
    expect(latestFilingRun(runs, 'prowler')).toBe(runs[0]);
  });

  it('returns undefined for a scan with no run', () => {
    expect(latestFilingRun(runs, 'active-defense')).toBeUndefined();
    expect(latestFilingRun([], 'web')).toBeUndefined();
  });
});

describe('scanSourceLabel', () => {
  it.each([
    ['web-owasp', 'Website'],
    ['cloud', 'Cloud baseline or Prowler'],
    ['active-defense', 'Active defense'],
    ['secrets', 'Secrets'],
    ['packages', 'Packages'],
    ['code-semgrep', 'Code'],
    ['something-new', 'something-new'],
  ])('labels %s as %s', (source, label) => {
    expect(scanSourceLabel(source)).toBe(label);
  });
});
