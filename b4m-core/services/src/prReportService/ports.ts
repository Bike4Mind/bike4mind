/**
 * PR report generator - provider ports.
 *
 * The core service depends only on these signatures, never on Octokit or the
 * Slack SDK. Adapters live in `apps/client/server/services/prReport/`, which is
 * where the credential resolvers and the HTTP clients belong.
 */

import type {
  ApprovalFetchResult,
  ChatMemberId,
  ChatMemberNameResult,
  ChatPostTarget,
  OpenPullRequestsPage,
  PostResult,
  SendReservation,
} from './types';

/**
 * Fetch all open PRs for a repo. REQUIRED signal - its failure fails the whole
 * generate request.
 *
 * MUST bound both each page (timeout) and the aggregate page walk, and MUST
 * honor GitHub's rate-limit headers, rejecting with a `RateLimitedFailure` so the
 * caller can tell the admin when to retry rather than hanging until the timeout.
 *
 * Reaching the aggregate bound is NOT a failure - it returns `truncated: true`,
 * never a partial list masquerading as complete.
 */
export type FetchOpenPullRequests = (repo: string) => Promise<OpenPullRequestsPage>;

/**
 * Fetch the set of PR numbers GitHub considers approved. ENRICHMENT - MUST
 * degrade on any failure (timeout, error, or a rate-limit rejection) by returning
 * `{ approved: emptySet, available: false }` so the report still generates.
 *
 * Note the search endpoint draws from a separate, much smaller rate-limit budget
 * than the PR-list REST reads, so it is usually the first call to throttle.
 */
export type FetchApprovedPrNumbers = (repo: string) => Promise<ApprovalFetchResult>;

/**
 * Resolve Slack member ids to display names for the proofreading preview. Runs
 * SERVER-SIDE on a credential carrying a user-lookup READ scope - never from the
 * client, which would put a bearer-equivalent credential in the browser.
 *
 * ENRICHMENT, exactly like the approval fetch: bounded by a timeout, and ANY
 * failure degrades to `{ names: {}, available: false }` rather than rejecting. A
 * preview showing raw member ids is honest; a failed generate is not.
 *
 * This is the capability's THIRD provider round-trip inside the synchronous
 * generate budget, after the PR-list walk and the approval search.
 */
export type FetchChatMemberNames = (memberIds: ChatMemberId[]) => Promise<ChatMemberNameResult>;

/**
 * Post already-final report text to Slack. MUST be bounded by a timeout and MUST
 * NOT run before the destination has passed the egress guard.
 *
 * NON-IDEMPOTENT: a post Slack already accepted can still time out, and a blind
 * retry re-pings the whole channel - so retry/backoff, which is correct for the
 * idempotent reads, MUST NOT be applied here.
 */
export type PostReport = (text: string, destination: ChatPostTarget) => Promise<PostResult>;

/**
 * Guard that MUST run on the admin-controlled repo identifier before it is
 * interpolated into any authenticated outbound URL. Throws when the value does not
 * match GitHub's `owner/repo` grammar - fully anchored, no empty or `..`
 * segments. SSRF / token-exfiltration mitigation.
 */
export type AssertRepoFormat = (repo: string) => void;

/**
 * Egress guard - the outbound-side analogue of AssertRepoFormat. Throws when the
 * destination is missing, or carries a URL that is not HTTPS or whose host is off
 * the operator-configured allowlist.
 *
 * The post body is the entire report (PR titles, author logins, repo URLs, the
 * staffing implied by the role rosters), so an unvalidated host is a
 * data-exfiltration channel, not merely a broken post.
 *
 * FAILS CLOSED: an unset or empty allowlist rejects every post and MUST NOT
 * degrade to allowing any host. Its message must name the check that failed and
 * never echo the value it rejected - the guard is handed the whole credential.
 */
export type AssertChatTargetFormat = (destination: ChatPostTarget | null | undefined) => void;

/**
 * The shared, short-TTL dedupe store behind send idempotency. REQUIRED - not an
 * enrichment - and the one place this capability fails closed.
 *
 * Must be reachable by every replica. An in-process map is a correctness trap: it
 * works in single-process dev and a single-process test suite, then silently does
 * nothing across Lambda invocations, producing the exact double-post it was meant
 * to prevent while the test still passes.
 */
export interface SendDedupeStore {
  /**
   * Atomic put-if-absent. Reserves `key` as `inFlight` with the window's TTL.
   *
   * @returns `{ reserved: true }` when this caller created the entry;
   *   `{ reserved: false, existing }` when someone else holds it - where
   *   `existing` may be undefined if the value could not be read back.
   * @throws when the store cannot CONFIRM the reserve (unreachable, timeout,
   *   error). The caller must then refuse the send rather than post unreserved.
   */
  reserve(
    key: string,
    reservation: SendReservation,
    ttlMs: number
  ): Promise<{ reserved: true } | { reserved: false; existing?: SendReservation }>;
  /**
   * Read an existing reservation. Returns null when nobody holds the key - a
   * THIRD answer distinct from in-flight and delivered, reachable because a
   * concurrent submit can release between this caller's failed reserve and this
   * read, and because the TTL can lapse in the same gap.
   */
  read(key: string): Promise<SendReservation | null>;
  /**
   * Conditionally flip the reservation to `delivered`, guarded on `ownerToken`.
   *
   * @returns false when this caller no longer owns the reservation.
   * @throws when the write itself errors - a different event from losing
   *   ownership, and one that must NOT be reported as an uncertain delivery.
   */
  markDelivered(key: string, ownerToken: string): Promise<boolean>;
  /**
   * Conditionally release the reservation, guarded on `ownerToken`. Called ONLY
   * on definite non-delivery.
   *
   * @returns false when this caller no longer owns the reservation.
   */
  release(key: string, ownerToken: string): Promise<boolean>;
}

/**
 * Counters/structured events for the degradations this capability tolerates.
 * Every one of them is silent by construction - the report still generates, still
 * looks normal, still posts - so a one-off log line is not enough. What matters is
 * whether a degradation is SUSTAINED, and that is only visible as a counter.
 */
export interface PrReportMetrics {
  /**
   * @param name what degraded
   * @param detail non-sensitive context (never a credential or a full URL)
   */
  increment(name: PrReportMetricName, detail?: Record<string, string | number | boolean | null>): void;
}

export type PrReportMetricName =
  /** Alert on SUSTAINED failure - every report is then missing its approved re-route. */
  | 'prReport.approvalDataUnavailable'
  /** Includes the retryAfterSeconds/resetAt actually returned, so throttling is visible. */
  | 'prReport.prListRateLimited'
  | 'prReport.prListFailed'
  /**
   * Alert when true on CONSECUTIVE runs: one truncated digest is a busy day, but a
   * run of them means the page bound sits permanently below the repo's steady
   * state and the digest is permanently dropping the oldest, most-stuck PRs.
   * Nothing else surfaces this - an advisory line printed in every digest stops
   * being read within a week.
   */
  | 'prReport.openPrListTruncated'
  /** Posted text is unaffected, but the ping list was approved unread. */
  | 'prReport.mentionNamesUnavailable'
  /**
   * ANY occurrence is worth an alert, not just a sustained run: this is the one
   * state meaning "a post to a shared channel may or may not have landed", and it
   * always requires a human to reconcile the channel by hand.
   */
  | 'prReport.deliveryUnknown'
  /**
   * The reserve could not be confirmed and the send was REFUSED. This dependency
   * blocks rather than degrades, so an unnoticed outage looks to admins like the
   * send button being broken.
   */
  | 'prReport.dedupeReserveUnavailable'
  /**
   * A conditional flip or release errored - the send was NOT refused, but the
   * reservation is now stale and will only clear on its TTL. The more insidious
   * kind: a run of these explains a run of check-the-channel advisories that
   * nothing else accounts for.
   */
  | 'prReport.dedupeWriteFailed';
