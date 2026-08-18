import { describe, it, expect, vi } from 'vitest';

import { generateReport, type GenerateReportDeps } from './generateReport';
import { BUCKET_SPECS } from './bucketSpecs';
import type { IdentityLookup, PullRequest } from './types';

const LOOKUP: IdentityLookup = {
  author: 'U0AUTHOR1',
  reviewer_: 'S0REVIEWERS',
  devops_: 'S0DEVOPS11',
};

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 100,
    title: 'Some change',
    url: 'https://github.com/Bike4Mind/bike4mind/pull/100',
    isDraft: false,
    authorLogin: 'author',
    assigneeLogins: [],
    labels: ['awaiting review'],
    requestedReviewerLogins: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GenerateReportDeps> = {}): GenerateReportDeps {
  return {
    fetchOpenPullRequests: vi.fn(async () => ({ prs: [pr()], truncated: false })),
    fetchApprovedPrNumbers: vi.fn(async () => ({ approved: new Set<number>(), available: true })),
    fetchChatMemberNames: vi.fn(async () => ({ names: {}, available: true })),
    assertRepoFormat: vi.fn(),
    metrics: { increment: vi.fn() },
    ...overrides,
  };
}

const PARAMS = {
  repo: 'Bike4Mind/bike4mind',
  identityLookup: LOOKUP,
  bucketSpecs: BUCKET_SPECS,
  renderOptions: { now: new Date('2026-08-13T12:00:00Z'), timeZone: 'UTC' },
};

describe('generateReport - required signal', () => {
  it('fails the whole request when the PR list fails', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => {
        throw new Error('upstream exploded');
      }),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('error');
  });

  it('runs the SSRF guard before anything else', async () => {
    const deps = makeDeps({
      assertRepoFormat: vi.fn(() => {
        throw new Error('repository identifier contains an empty or relative path segment');
      }),
    });

    const outcome = await generateReport({ ...PARAMS, repo: 'owner/..' }, deps);

    expect(outcome.ok).toBe(false);
    expect(deps.fetchOpenPullRequests).not.toHaveBeenCalled();
  });
});

describe('generateReport - rate-limit carry-through', () => {
  it('surfaces the provider retry advice all the way to the caller', async () => {
    // Asserting it survives the ORCHESTRATOR, not just the port - a generic handler
    // swallowing this is the whole failure mode.
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => {
        throw { kind: 'rateLimited', rateLimit: { retryAfterSeconds: 42, resetAt: '2026-08-13T12:30:00.000Z' } };
      }),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'rateLimited', rateLimit: { retryAfterSeconds: 42, resetAt: '2026-08-13T12:30:00.000Z' } },
    });
    expect(deps.metrics.increment).toHaveBeenCalledWith(
      'prReport.prListRateLimited',
      expect.objectContaining({ retryAfterSeconds: 42 })
    );
  });

  it('treats a throttle with no advice as still a throttle', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => {
        throw { kind: 'rateLimited', rateLimit: { retryAfterSeconds: null, resetAt: null } };
      }),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.kind === 'rateLimited') {
      expect(outcome.failure.rateLimit).toEqual({ retryAfterSeconds: null, resetAt: null });
    }
  });
});

describe('generateReport - approval degradation is surfaced, not silent', () => {
  it('flags an unavailable approval source and leaves isApproved UNDEFINED', async () => {
    const prs = [pr({ labels: ['awaiting review'] })];
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs, truncated: false })),
      fetchApprovedPrNumbers: vi.fn(async () => ({ approved: new Set<number>(), available: false })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.warnings.approvalDataUnavailable).toBe(true);
    expect(outcome.response.text.toLowerCase()).toContain('approval data was unavailable');
    // Never written as `false` - that would read identically to a genuine not-approved
    // and would file approved PRs back under their stale review gates.
    expect(prs[0].isApproved).toBeUndefined();
    expect(deps.metrics.increment).toHaveBeenCalledWith('prReport.approvalDataUnavailable');
  });

  it('does NOT flag an available fetch that genuinely found nobody approved', async () => {
    // The distinguishing case: an empty set from a healthy source is a fact, not a
    // degradation, and the two are the same empty set without the availability flag.
    const prs = [pr()];
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs, truncated: false })),
      fetchApprovedPrNumbers: vi.fn(async () => ({ approved: new Set<number>(), available: true })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.warnings.approvalDataUnavailable).toBe(false);
    expect(prs[0].isApproved).toBe(false);
  });

  it('re-routes approved PRs when the source is available', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({
        prs: [pr({ number: 7, labels: ['awaiting review'] })],
        truncated: false,
      })),
      fetchApprovedPrNumbers: vi.fn(async () => ({ approved: new Set([7]), available: true })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.text).toContain('Approved - awaiting author');
  });

  it('still generates when the approval fetch throws', async () => {
    const deps = makeDeps({
      fetchApprovedPrNumbers: vi.fn(async () => {
        throw new Error('search threw');
      }),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.warnings.approvalDataUnavailable).toBe(true);
  });
});

describe('generateReport - truncation is surfaced, not silent', () => {
  it('flags truncation, treats prCount as a floor, and says so in the text', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs: [pr()], truncated: true })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.warnings.openPrListTruncated).toBe(true);
    expect(outcome.response.text).toContain('1+ open PRs');
    expect(outcome.response.text.toLowerCase()).toContain('omitted');
    expect(deps.metrics.increment).toHaveBeenCalledWith('prReport.openPrListTruncated', expect.anything());
  });
});

describe('generateReport - mention-name lookup', () => {
  it('flags a degraded lookup', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs: [pr({ requestedReviewerLogins: [] })], truncated: false })),
      fetchChatMemberNames: vi.fn(async () => ({ names: {}, available: false })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.mentionNamesUnavailable).toBe(true);
    expect(deps.metrics.increment).toHaveBeenCalledWith('prReport.mentionNamesUnavailable');
  });

  it('does NOT flag a report that genuinely mentions nobody', async () => {
    // Same empty map, opposite meaning. Without the flag an admin cannot tell an
    // unverified ping list from a report with no pings.
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({
        prs: [pr({ authorLogin: 'unmapped-person', labels: ['done reviewing'] })],
        truncated: false,
      })),
      fetchChatMemberNames: vi.fn(async () => ({ names: {}, available: true })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.mentionNames).toEqual({});
    expect(outcome.response.mentionNamesUnavailable).toBe(false);
  });

  it('reads the flag from the port even when a partial map came back', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs: [pr({ requestedReviewerLogins: [] })], truncated: false })),
      // A lookup cut short after resolving some ids: the map is non-empty AND degraded,
      // so the flag can never be inferred from emptiness.
      fetchChatMemberNames: vi.fn(async () => ({ names: { S0REVIEWERS: 'Reviewers' }, available: false })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.response.mentionNames).toEqual({ S0REVIEWERS: 'Reviewers' });
    expect(outcome.response.mentionNamesUnavailable).toBe(true);
  });

  it('only asks for the member ids the text actually mentions', async () => {
    const fetchChatMemberNames = vi.fn(async () => ({ names: {}, available: true }));
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({
        prs: [pr({ labels: ['awaiting review'], requestedReviewerLogins: [] })],
        truncated: false,
      })),
      fetchChatMemberNames,
    });

    await generateReport(PARAMS, deps);

    expect(fetchChatMemberNames).toHaveBeenCalledWith(expect.arrayContaining(['S0REVIEWERS']));
    expect(fetchChatMemberNames.mock.calls[0][0]).not.toContain('S0DEVOPS11');
  });
});

describe('generateReport - roster field validation', () => {
  it('fails rather than blanket-pinging when the provider never populates the gate field', async () => {
    // ABSENT IS NOT EMPTY. Undefined on every PR means the query did not select
    // reviewers, which would read as "nobody specific" and tag the whole pool daily.
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({
        prs: [pr({ requestedReviewerLogins: undefined })],
        truncated: false,
      })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.kind === 'error') {
      expect(outcome.failure.reason).toContain('requestedReviewerLogins');
    }
  });

  it('accepts an empty array, which is an ordinary open gate', async () => {
    const deps = makeDeps({
      fetchOpenPullRequests: vi.fn(async () => ({ prs: [pr({ requestedReviewerLogins: [] })], truncated: false })),
    });

    const outcome = await generateReport(PARAMS, deps);

    expect(outcome.ok).toBe(true);
  });
});
