/**
 * PR report generator - the generate half of the two-phase flow.
 *
 * READ-ONLY: it fetches, classifies and renders, and persists nothing. It returns
 * formatted-but-UNSENT text for a human to review and edit. It must never post -
 * that boundary is the whole point of the design, and collapsing it into one
 * auto-posting call is the one change this capability cannot absorb.
 *
 * The required signal is the PR list; its failure fails the request. The two
 * enrichments (approval state, Slack display names) degrade independently, and
 * each degradation is surfaced rather than swallowed.
 */

import { buildReport, type BuildReportOptions } from './buildReport';
import { validateSpecificOwnerFieldsPopulated } from './validateBucketSpecs';
import type {
  ApprovalFetchResult,
  BucketSpecs,
  ChatMemberId,
  ChatMemberNameResult,
  GenerateReportFailure,
  GenerateReportResponse,
  GenerateReportWarnings,
  IdentityLookup,
  PullRequest,
  RateLimitedFailure,
} from './types';
import type {
  AssertRepoFormat,
  FetchApprovedPrNumbers,
  FetchChatMemberNames,
  FetchOpenPullRequests,
  PrReportMetrics,
} from './ports';

/**
 * Overall synchronous budget for a generate, sized over ALL THREE provider
 * round-trips (the paginated PR-list walk, the approval search, the member-name
 * lookup) - a budget computed from the first two silently under-counts.
 *
 * Platform sizing for lumina5: the Next.js server runs as an SST `sst.aws.Nextjs`
 * Lambda with `server.timeout: '60 seconds'`, reached through a CloudFront Router
 * rather than API Gateway. So there is no 29s API-Gateway integration cap to duck,
 * but CloudFront's origin-response timeout is the real ceiling and is lower than
 * the Lambda's own. We therefore take the blueprint's second remedy: keep the
 * budget under the CDN ceiling and size the page-walk bound to fit THAT budget, so
 * an oversized repo returns `truncated: true` and a digest that says so, instead of
 * a 504 and no digest at all.
 */
export const GENERATE_BUDGET_MS = 25_000;

export interface GenerateReportDeps {
  fetchOpenPullRequests: FetchOpenPullRequests;
  fetchApprovedPrNumbers: FetchApprovedPrNumbers;
  fetchChatMemberNames: FetchChatMemberNames;
  assertRepoFormat: AssertRepoFormat;
  metrics: PrReportMetrics;
}

export interface GenerateReportParams {
  repo: string;
  identityLookup: IdentityLookup;
  bucketSpecs: BucketSpecs;
  /** Passed through to the renderer; injected for deterministic tests. */
  renderOptions?: BuildReportOptions;
  budgetMs?: number;
}

export type GenerateReportOutcome =
  { ok: true; response: GenerateReportResponse } | { ok: false; failure: GenerateReportFailure };

function isRateLimitedFailure(error: unknown): error is RateLimitedFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'rateLimited' &&
    'rateLimit' in error
  );
}

/**
 * Run an enrichment under the remaining budget, degrading to `fallback` on ANY
 * failure - timeout, rejection, or a thrown provider error.
 *
 * Deliberately swallowing here is correct: a poorer report beats no report. The
 * caller is responsible for turning the degradation into a warning flag and a
 * counter, which is what keeps it from being silent.
 */
async function enrichOrDegrade<T>(
  operation: () => Promise<T>,
  fallback: T,
  remainingMs: number,
  onDegrade: (error: unknown) => void
): Promise<T> {
  if (remainingMs <= 0) {
    onDegrade(new Error('generate budget exhausted before enrichment'));
    return fallback;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('enrichment exceeded remaining generate budget')), remainingMs);
      }),
    ]);
  } catch (error) {
    onDegrade(error);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Member ids the rendered text actually mentions. */
function mentionedMemberIds(text: string): ChatMemberId[] {
  const found = new Set<ChatMemberId>();
  for (const match of text.matchAll(/<@([UWS][A-Z0-9]+)>/g)) {
    found.add(match[1]);
  }
  return [...found];
}

export async function generateReport(
  params: GenerateReportParams,
  deps: GenerateReportDeps
): Promise<GenerateReportOutcome> {
  const { repo, identityLookup, bucketSpecs } = params;
  const budgetMs = params.budgetMs ?? GENERATE_BUDGET_MS;
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  // SSRF guard, BEFORE any URL is built from the admin-editable repo string.
  try {
    deps.assertRepoFormat(repo);
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'error', reason: error instanceof Error ? error.message : 'invalid repository identifier' },
    };
  }

  // Required signal. A rate-limit rejection is carried through to the caller so the
  // admin is told WHEN to retry - a generic error here is the whole failure mode
  // this arm exists to prevent.
  let prs: PullRequest[];
  let truncated: boolean;
  try {
    const page = await deps.fetchOpenPullRequests(repo);
    prs = page.prs;
    truncated = page.truncated;
  } catch (error) {
    if (isRateLimitedFailure(error)) {
      deps.metrics.increment('prReport.prListRateLimited', {
        retryAfterSeconds: error.rateLimit.retryAfterSeconds,
        resetAt: error.rateLimit.resetAt,
      });
      return { ok: false, failure: error };
    }
    deps.metrics.increment('prReport.prListFailed');
    return {
      ok: false,
      failure: { kind: 'error', reason: error instanceof Error ? error.message : 'failed to fetch open pull requests' },
    };
  }

  if (truncated) {
    // Alert on CONSECUTIVE runs: one truncated digest is a busy day, a run of them
    // means the bound sits permanently below the repo's steady state and the digest
    // is permanently dropping the oldest, most-stuck PRs.
    deps.metrics.increment('prReport.openPrListTruncated', { prCount: prs.length });
  }

  // A roster bucket whose gate reads a field the provider never populates would
  // read every PR as "nobody specific" and blanket-ping the pool on every run. That
  // is a configuration error, not an open gate, so it fails the generate.
  const fieldErrors = validateSpecificOwnerFieldsPopulated(bucketSpecs, prs);
  if (fieldErrors.length) {
    return {
      ok: false,
      failure: {
        kind: 'error',
        reason: `bucket configuration is invalid: ${fieldErrors
          .map(error => `${error.bucket} - ${error.reason}`)
          .join('; ')}`,
      },
    };
  }

  const warnings: GenerateReportWarnings = {
    approvalDataUnavailable: false,
    openPrListTruncated: truncated,
  };

  // Enrichment 1: approval state.
  const approval = await enrichOrDegrade<ApprovalFetchResult>(
    () => deps.fetchApprovedPrNumbers(repo),
    { approved: new Set<number>(), available: false },
    remaining(),
    () => undefined
  );

  if (approval.available) {
    // Only now is `false` a fact rather than a guess.
    for (const pr of prs) {
      pr.isApproved = approval.approved.has(pr.number);
    }
  } else {
    // Leave every `isApproved` UNDEFINED. Writing `false` would read identically to
    // a genuine "not approved" and would quietly file approved PRs back under their
    // stale review gates - a report that lies is harder to catch than one that errors.
    warnings.approvalDataUnavailable = true;
    deps.metrics.increment('prReport.approvalDataUnavailable');
  }

  const text = buildReport(prs, identityLookup, bucketSpecs, warnings, params.renderOptions);

  // Enrichment 2: display names for the proofreading preview, computed over the
  // text we just rendered so the map covers exactly what it mentions.
  const memberIds = mentionedMemberIds(text);
  const memberNames = memberIds.length
    ? await enrichOrDegrade<ChatMemberNameResult>(
        () => deps.fetchChatMemberNames(memberIds),
        { names: {}, available: false },
        remaining(),
        () => undefined
      )
    : // Nothing to resolve is not a degradation: an empty map with `available: true`
      // is exactly the "mentions nobody" case the flag exists to distinguish.
      ({ names: {}, available: true } satisfies ChatMemberNameResult);

  if (!memberNames.available) {
    // The posted text is unaffected - Slack resolves member ids itself - but the
    // admin's preview shows raw ids, so the ping list was approved unread.
    deps.metrics.increment('prReport.mentionNamesUnavailable');
  }

  return {
    ok: true,
    response: {
      text,
      prCount: prs.length,
      warnings,
      mentionNames: memberNames.names,
      // Read from the port, never inferred from whether the map came back empty.
      mentionNamesUnavailable: !memberNames.available,
    },
  };
}
