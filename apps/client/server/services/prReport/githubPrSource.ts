/**
 * PR report generator - GitHub adapter.
 *
 * Binds the blueprint's two source-control ports onto GitHubService, which already
 * owns the managed credential resolution (GitHub App, else service-account PAT),
 * the rate-limit response hooks and the repo allowlist. No token is read from the
 * environment here and none is hard-coded.
 */

import { GitHubRateLimitedError, GitHubService, type GitHubOpenPullRequest } from '@server/services/githubService';
import type { Logger } from '@bike4mind/observability';
import type { ApprovalFetchResult, OpenPullRequestsPage, PullRequest, RateLimitedFailure } from '@bike4mind/services';

/**
 * Per-call ceilings. Both reads sit inside the generate's ~25s synchronous budget
 * alongside the Slack member-name lookup, so neither may stall the request until the
 * Lambda's own 60s limit.
 */
const PR_LIST_TIMEOUT_MS = 12_000;
const APPROVAL_SEARCH_TIMEOUT_MS = 8_000;

/**
 * Aggregate page-walk bound: 2 pages × 100 = 200 open PRs.
 *
 * Sized ABOVE the repo's steady state (~36 open PRs) so truncation stays
 * exceptional rather than permanent, and comfortably under the generate budget. A
 * permanently-truncated digest would print the same advisory every day until nobody
 * read it, while dropping PRs below the classifier.
 */
const MAX_PR_PAGES = 2;
const PR_PAGE_SIZE = 100;

/** Reject with a plain Error on timeout so callers classify it as a normal failure. */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toPullRequest(pr: GitHubOpenPullRequest): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    isDraft: pr.draft,
    authorLogin: pr.user?.login ?? null,
    assigneeLogins: pr.assignees.map(a => a.login),
    // Always an array. The roster gate treats an ABSENT field as a configuration
    // error rather than an open gate, so this must never become undefined.
    requestedReviewerLogins: pr.requested_reviewers.map(r => r.login),
    labels: pr.labels.map(l => l.name).filter(Boolean),
    // `isApproved` is left UNSET here on purpose. Only the approval enrichment may
    // write it, and only when that fetch reported itself available.
  };
}

function asRateLimitedFailure(error: unknown): RateLimitedFailure | null {
  if (!(error instanceof GitHubRateLimitedError)) return null;
  return {
    kind: 'rateLimited',
    rateLimit: {
      retryAfterSeconds: error.retryAfterSeconds,
      resetAt: error.resetAt,
    },
  };
}

/**
 * The REQUIRED open-PR fetch. Its failure fails the whole generate - there is no
 * partial-success mode, because a digest missing an unknown share of the repo is
 * worse than no digest.
 *
 * A throttle rejects with a `RateLimitedFailure` rather than a generic error, so the
 * endpoint can tell the admin when to retry.
 */
export function createFetchOpenPullRequests(logger: Logger) {
  return async function fetchOpenPullRequests(repo: string): Promise<OpenPullRequestsPage> {
    const github = await GitHubService.forSystem(logger);
    if (!github) {
      throw new Error('no GitHub connection is configured');
    }

    try {
      const result = await withTimeout(
        github.listOpenPullRequests(repo, { maxPages: MAX_PR_PAGES, perPage: PR_PAGE_SIZE }),
        PR_LIST_TIMEOUT_MS,
        'GitHub open-PR list'
      );

      return {
        prs: result.prs.map(toPullRequest),
        truncated: result.truncated,
      };
    } catch (error) {
      const rateLimited = asRateLimitedFailure(error);
      if (rateLimited) throw rateLimited;
      throw error;
    }
  };
}

/**
 * The approval ENRICHMENT. Degrades on ANY failure - timeout, error, or a
 * rate-limit rejection - by returning `available: false` so the report still
 * generates.
 *
 * Returning an availability flag rather than a bare empty set is the whole point:
 * an empty set from a healthy search ("nobody is approved") and an empty set from a
 * failed one are byte-identical, and a caller that cannot tell them apart writes
 * `isApproved: false` on every PR and files approved PRs back under their stale
 * review gates.
 */
export function createFetchApprovedPrNumbers(logger: Logger) {
  return async function fetchApprovedPrNumbers(repo: string): Promise<ApprovalFetchResult> {
    try {
      const github = await GitHubService.forSystem(logger);
      if (!github) {
        logger.warn('[PrReport] Approval enrichment skipped - no GitHub connection configured');
        return { approved: new Set<number>(), available: false };
      }

      const approved = await withTimeout(
        github.searchApprovedPullRequestNumbers(repo),
        APPROVAL_SEARCH_TIMEOUT_MS,
        'GitHub approval search'
      );

      return { approved, available: true };
    } catch (error) {
      // The search endpoint draws on a much smaller budget than the REST reads, so
      // this is usually the first call to throttle on a busy repo.
      logger.warn('[PrReport] Approval enrichment degraded', {
        reason: error instanceof Error ? error.message : 'unknown',
        rateLimited: error instanceof GitHubRateLimitedError,
      });
      return { approved: new Set<number>(), available: false };
    }
  };
}
