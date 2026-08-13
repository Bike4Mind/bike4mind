/**
 * PR report generator - domain types.
 *
 * Applied from the `pr-report-generator` blueprint (MillionOnMars/blueprints).
 * The blueprint's `Bucket` / `PriorityTier` unions are a worked example of the
 * SOURCE team's workflow; the taxonomy below is lumina5's own, derived from the
 * labels actually in use on Bike4Mind/bike4mind. What survives the replacement
 * is not the names but the structural roles each bucket plays - see BucketRole.
 */

/** The subset of an open pull request the classifier and renderer need. */
export interface PullRequest {
  /** GitHub PR number, used for links and a stable descending sort. */
  number: number;
  title: string;
  /** Canonical web URL for the PR (used to build the linked mention). */
  url: string;
  /** True when the PR is a draft / not ready for review. */
  isDraft: boolean;
  /** Author login, or null when unavailable. */
  authorLogin: string | null;
  /** Assignee logins, in provider order; first is treated as accountable. */
  assigneeLogins: string[];
  /** Label names as GitHub displays them (matched case-insensitively). */
  labels: string[];
  /**
   * Logins whose review is still pending. GitHub drops a reviewer from
   * `requested_reviewers` once they submit, so this names exactly who still owes
   * a review - which is what makes it usable as a review-gate roster input.
   *
   * Optional in the contract, but the GitHub adapter ALWAYS populates it (with
   * `[]` when nobody is requested). That matters: `validateBucketSpecs` rejects a
   * roster bucket naming a field the provider leaves undefined, because absent
   * would otherwise read as "nobody specific" and blanket-ping the pool daily.
   */
  requestedReviewerLogins?: string[];
  /**
   * Enrichment signal merged in after the list fetch: the PR has an approving
   * review and no outstanding change request.
   *
   * Three-state on purpose. `true`/`false` mean "checked - approved / not
   * approved"; `undefined` means UNKNOWN, i.e. the approval source was
   * unavailable. Callers MUST leave this undefined (never write `false`) when
   * the approval fetch reports `available: false` - collapsing unknown into
   * false silently files approved PRs back under their stale review gates.
   */
  isApproved?: boolean;
}

/**
 * lumina5's workflow buckets, one per state a PR can be in. Every open PR maps
 * to exactly one; `none` guarantees that totality.
 *
 * Each member is annotated with the structural role it plays in the precedence.
 */
export type Bucket =
  | 'release' // [shortCircuit] autorelease PR, outside the review/QA flow
  | 'draft' // [shortCircuit] draft / not ready for review
  | 'qaInProgress' // [testing] actively in QA
  | 'awaitingTesting' // [testing] queued for QA
  | 'qaClarification' // [testing] QA is blocked pending an answer
  | 'qaFailed' // [standalone] QA rejected it; ball is on the author, NOT a review gate
  | 'mergeConflict' // [standalone] mechanically blocked; author must resolve
  | 'awaitingFix' // [standalone] author applying agreed changes; approval does NOT re-route
  | 'onHold' // [standalone] deliberately parked
  | 'approvedAwaitingAuthor' // [approvedReroute] approved; stale gate → ball back on author
  | 'changeRequest' // [reviewGate] changes requested (still a review gate)
  | 'awaitingSpecialReview' // [reviewGate] waiting on the devops review pool
  | 'awaitingReview' // [reviewGate] waiting on a general code review
  | 'reviewOngoing' // [reviewGate] review started, not finished
  | 'readyForMerge' // [reviewGate] gate cleared, queued to merge
  | 'approved' // [approvedGeneric] approved with no more-specific state to show
  | 'dependencies' // [standalone] dependency bumps; title fallback AFTER labels
  | 'inProgress' // [standalone] WIP / not yet up for review
  | 'none'; // [catchAll] guarantees totality

/**
 * Priority tiers, most urgent first. `null` means "no priority label" and always
 * sorts LAST within a section, rendered as "standard" - deliberately not "none",
 * which would collide with the catch-all Bucket literal.
 */
export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3' | null;

/**
 * The structural role a bucket plays in the classification precedence. THIS -
 * not the bucket names - is what the ordering invariants depend on:
 *  - shortCircuit    matched first; never leaks into a workflow section
 *  - testing         QA/testing; checked BEFORE approval so approval can't pull a PR out of QA
 *  - reviewGate      awaiting some review; an approved PR is re-routed OUT of these
 *  - approvedReroute destination of the review-gate re-route ("approved - awaiting author")
 *  - approvedGeneric generic "approved"; checked AFTER every more-specific state
 *  - standalone      matched on its own, outside the testing/approval/review-gate interactions
 *  - catchAll        absorbs anything unmatched - the totality guarantee
 */
export type BucketRole =
  'shortCircuit' | 'testing' | 'reviewGate' | 'approvedReroute' | 'approvedGeneric' | 'standalone' | 'catchAll';

/** Owner tag (a specific accountable person) vs role-roster tag (a pool). */
export type MentionStrategy = 'owner' | 'roleRoster';

/**
 * Which PR field names the individual specifically on the hook for a bucket's
 * kind of work. This is the input the roster gate tests: the pool is added to the
 * section header only when at least one PR in the section has nobody specific by
 * this measure.
 *
 * There is NO implicit default - `validateBucketSpecs` rejects a roleRoster spec
 * that omits it. An implicit 'requestedReviewer' is the trap: it is right for the
 * review gates a consumer writes first and wrong for every QA bucket, where
 * review has already finished so the list is empty by construction, leaving an
 * always-open gate that blanket-pings the whole pool on every single digest.
 */
export type SpecificOwnerField = 'requestedReviewer' | 'assignee';

/**
 * Per-bucket render + precedence spec. Carried as DATA rather than as prose the
 * renderer hard-codes, which is what keeps `buildReport` generic: section order,
 * title, mention strategy, priority sub-grouping, the roster key and the roster
 * gate's input all live here.
 */
export interface BucketSpec {
  /** Structural role - drives the precedence invariants. */
  role: BucketRole;
  /** Rendered section title. */
  title: string;
  /** Precedence + render order; lower is checked / rendered first. */
  order: number;
  /** Owner mention vs role-roster mention for this section. */
  mention: MentionStrategy;
  /**
   * Synthetic role-key prefix for roster resolution (e.g. `reviewer_`,
   * `devops_`). Required when `mention` is 'roleRoster'; unused otherwise.
   */
  roleKey?: string;
  /** Required when `mention` is 'roleRoster'; unused otherwise. */
  specificOwner?: SpecificOwnerField;
  /** When true, sub-group the section by PriorityTier (P0 → P3 → standard). */
  subGroupByPriority: boolean;
}

/** One spec per bucket. */
export type BucketSpecs = Record<Bucket, BucketSpec>;

/** A Slack member id that actually produces a notification mention. */
export type ChatMemberId = string;

/**
 * Lookup from a GitHub login (lowercased) OR a synthetic role key (`qa_*`,
 * `devops_*`, `reviewer_*`) to a Slack member id. One keyspace, not two, so the
 * same map drives both per-user and per-pool mentions.
 */
export type IdentityLookup = Record<string, ChatMemberId>;

/** One `key -> memberId` mapping parsed out of the free-text identity setting. */
export interface ParsedIdentityMapEntry {
  /** GitHub login (lowercased) or synthetic role key, e.g. `qa_lead`. */
  key: string;
  memberId: ChatMemberId;
}

export interface ParsedIdentityMapError {
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedIdentityMapResult {
  entries: ParsedIdentityMapEntry[];
  errors: ParsedIdentityMapError[];
}

/**
 * Conditions under which a report was produced degraded or partial. Every flag
 * that is true is BOTH carried here and rendered into the report text, so the
 * posted digest is self-describing - a channel reader sees the caveat instead of
 * a normal-looking report that quietly under-reports.
 */
export interface GenerateReportWarnings {
  /**
   * The approval-enrichment source was unavailable. The "approved - awaiting
   * author" re-route did NOT run, so approved PRs may still sit under their stale
   * review-gate sections. Distinct from "no PR is approved", which is an
   * available fetch returning an empty set and carries no warning.
   */
  approvalDataUnavailable: boolean;
  /**
   * The open-PR page walk hit its aggregate bound. PRs beyond it - typically the
   * OLDEST, most-stuck ones - are absent, and `prCount` is a floor, not a total.
   */
  openPrListTruncated: boolean;
}

/** What the provider said about a throttle, so the admin is told WHEN to retry. */
export interface RateLimitInfo {
  /** Provider `Retry-After`, normalized to whole seconds; null when absent. */
  retryAfterSeconds: number | null;
  /** Provider rate-limit reset instant (ISO 8601); null when absent. */
  resetAt: string | null;
}

/**
 * The rejection a REQUIRED fetch produces when GitHub throttles it, rather than
 * an undifferentiated error or a hang until the timeout. Both `rateLimit` fields
 * are nullable: a throttle with no provider advice is still a throttle.
 */
export interface RateLimitedFailure {
  kind: 'rateLimited';
  rateLimit: RateLimitInfo;
}

/** Result of the required open-PR fetch. */
export interface OpenPullRequestsPage {
  prs: PullRequest[];
  /**
   * True when the aggregate page-walk bound was reached before GitHub signalled
   * its last page. A page cap drops PRs BELOW the classifier, where the catch-all
   * cannot absorb them, so this MUST be surfaced rather than silently dropped.
   */
  truncated: boolean;
}

/** Result of the approval-enrichment fetch. */
export interface ApprovalFetchResult {
  /**
   * PR numbers GitHub considers approved. An empty set is meaningful ONLY when
   * `available` is true (genuinely "none approved").
   */
  approved: Set<number>;
  /**
   * False when the approval source was unavailable - timeout, error, or a
   * rate-limit rejection. This flag is what disambiguates degrade-to-empty from
   * "nobody approved": without it the two are the same empty set.
   */
  available: boolean;
}

/** Result of the Slack member-name lookup behind the proofreading preview. */
export interface ChatMemberNameResult {
  /** Display names for the ids that resolved; unresolved ids are simply absent. */
  names: Record<ChatMemberId, string>;
  /**
   * False when the lookup degraded - a timeout, an error, a credential without
   * the read scope, a rate-limit rejection, INCLUDING a partial map cut short by
   * one of those. Exactly the role `ApprovalFetchResult.available` plays: two ids
   * requested and one returned is a deactivated member on a healthy lookup and a
   * timeout mid-batch on a broken one, and the map is identical either way.
   */
  available: boolean;
}

/**
 * Where the digest is posted. lumina5 uses a bot token + channel rather than an
 * incoming webhook, deliberately: a post-only webhook has no read scope, so
 * `FetchChatMemberNames` could never resolve display names and the proofreading
 * preview would permanently show raw member ids.
 */
export type ChatPostTarget = { token: string; channel: string };

/**
 * How a FAILED post ended, from the poster's point of view. This is the single
 * distinction the send dedupe's release rule turns on.
 */
export type PostDelivery =
  /**
   * The provider DID NOT ACCEPT the post and that is determinable: DNS failure,
   * TLS failure, connection refused, request never transmitted, or a rejection
   * returned before the body was accepted. The test is acceptance, not
   * reachability - a 4xx plainly reached Slack and was read, but Slack declined
   * it, so nothing was posted and the reservation is safe to release.
   */
  | 'notDelivered'
  /**
   * Genuinely unknown: the request was transmitted and the outcome was not. A
   * read timeout, a connection reset after send, a 5xx after the body was
   * accepted. The post MAY have landed, so the reservation MUST be held.
   */
  | 'unknown';

export interface PostReportFailure {
  delivery: PostDelivery;
  /**
   * Provider-supplied detail, for SERVER-SIDE logs and audit ONLY. Never returned
   * in the send endpoint's response, and scrubbed of the destination before
   * logging. Slack errors routinely echo the request target, and returning this
   * to the browser would put a bearer-equivalent credential in devtools, error
   * toasts, screenshots and the front-end error tracker.
   */
  reason?: string;
}

/**
 * The outcome of one post attempt. A RESULT rather than a bare resolve/reject,
 * because `delivery` is the branch the release rule turns on - returning it makes
 * that branch unavoidable at compile time instead of a documented hope.
 */
export type PostResult = { accepted: true } | ({ accepted: false } & PostReportFailure);

/** Generate response: editable text plus a count and any degradation flags. */
export interface GenerateReportResponse {
  text: string;
  /** A FLOOR, not a total, when `warnings.openPrListTruncated` is true. */
  prCount: number;
  /** Present (all flags false) on a clean report, so callers never null-check. */
  warnings: GenerateReportWarnings;
  /**
   * Display names for the Slack member ids `text` mentions, for the proofreading
   * preview. Resolved SERVER-SIDE and shipped here - there is deliberately no
   * client-side lookup, because the Slack credential is bearer-equivalent and
   * must never reach the browser.
   *
   * An empty map is AMBIGUOUS on its own: read `mentionNamesUnavailable`.
   */
  mentionNames: Record<ChatMemberId, string>;
  /**
   * True when the member-name lookup degraded. Copied from the port's
   * availability flag, NOT inferred from `mentionNames` - an empty map is
   * indistinguishable across four worlds (nobody mentioned, no read scope,
   * timeout, partial failure), and an admin proofreading who gets pinged cannot
   * otherwise tell a transient failure from normal output.
   *
   * Deliberately NOT part of GenerateReportWarnings: those describe a degraded
   * *report* and are all rendered into the text. This describes a degraded
   * *preview* - the posted text is byte-identical either way, since Slack
   * resolves member ids itself - so rendering it into the channel would be noise.
   */
  mentionNamesUnavailable: boolean;
}

/**
 * How a generate request failed. Generation has no partial-success mode - the PR
 * list is a required signal.
 *
 * The `rateLimited` arm is the endpoint-level home for the rate-limit
 * carry-through: a port-level rejection that no response shape can carry gets
 * swallowed by a generic 500 handler, leaving the admin to retry immediately and
 * re-burn the throttled budget.
 */
export type GenerateReportFailure =
  | RateLimitedFailure
  | {
      kind: 'error';
      /** Server-side detail; scrub credentials before logging or returning. */
      reason?: string;
    };

/**
 * The state a dedupe reservation holds. Key PRESENCE alone is not enough: an
 * existing key cannot distinguish a send that landed from one still outstanding,
 * and that is exactly the difference between 'deduped' and 'deliveryUnknown'.
 */
export type SendReservationState =
  /**
   * Reserved and NOT known to have delivered. Two ways to be here: the post is
   * still outstanding, or it ended ambiguously and the reservation was
   * deliberately held. Not distinguished, because both call for the same answer.
   */
  | 'inFlight'
  /** Slack accepted the post. A later submit reading this returns 'deduped'. */
  | 'delivered';

/**
 * The value a dedupe reservation holds in the shared store.
 *
 * `ownerToken` exists because the flip and the release are writes made AFTER the
 * post returns, by which time this submit may no longer own the key: the TTL is
 * set once at reserve, and a submit that stalls past it can settle after the
 * entry expired and a DIFFERENT submit reserved it. An unconditional delete would
 * then destroy the new owner's `delivered` reservation and re-open the
 * double-post; an unconditional flip would mark a stale post delivered and
 * suppress a legitimate new one.
 */
export interface SendReservation {
  state: SendReservationState;
  /** Opaque, unique per submit. Never derived from the text. */
  ownerToken: string;
}

/** Send request: the human-edited text, bounded to Slack's payload limit. */
export interface SendReportRequest {
  text: string;
  /**
   * Optional client-supplied idempotency key. Preferred over the (text, repo)
   * hash fallback because it is exact - it identifies THIS submit attempt, so it
   * distinguishes a retry from a deliberate identical re-send.
   *
   * The hash fallback over-matches, which is the safer direction, but it also has
   * no escape from a held reservation: the key is a function of the text, so
   * every resubmit of the same digest returns 'deliveryUnknown' until the TTL
   * lapses. On the keyed path an admin can check the channel and re-submit under
   * a fresh key.
   */
  idempotencyKey?: string;
}

export interface SendReportResponse {
  /**
   * 'sent' - posted on THIS call and Slack accepted it.
   * 'deduped' - a matching prior send was found within the window AND its
   *   reservation reads `delivered`; nothing was posted on this call.
   * 'deliveryUnknown' - nothing was posted on THIS call and whether ANY post
   *   landed is genuinely not known. Two ways in: this call's own post ended
   *   ambiguously, or it read a matching reservation still `inFlight`. The caller
   *   MUST surface this as "check the channel before retrying" - never as
   *   success, and never as a plain failure the client is free to retry, because
   *   that retry is the double-post the dedupe exists to prevent.
   *
   * Three and not two because, under reserve-before-post, 'deduped' cannot
   * honestly claim delivery for a reservation that is merely reserved.
   *
   * These are the SUCCESS-PATH outcomes. A definite non-delivery is a fourth
   * terminal case and produces none of them - see SendReportFailure.
   */
  outcome: 'sent' | 'deduped' | 'deliveryUnknown';
}

/**
 * How a send request failed - i.e. produced no SendReportResponse at all.
 * Distinct from `outcome: 'deliveryUnknown'`, which is a *successful* request
 * reporting an uncertain delivery.
 *
 * THIS TYPE CROSSES THE WIRE, so no member carries provider-supplied detail. The
 * `reason` fields are the ENDPOINT's own message about what it rejected and MUST
 * NOT be populated by forwarding a caught error. That is why 'notDelivered' - the
 * one arm whose cause IS a provider error - carries no `reason` at all: the field
 * would make `reason: postResult.reason` the obvious wiring, and that one line is
 * the credential leak.
 */
export type SendReportFailure =
  | {
      /**
       * Slack did not accept the post and that is determinable, so the
       * reservation was RELEASED. Nothing was posted; the caller MAY retry
       * immediately, and should, since no digest reached the channel.
       */
      kind: 'notDelivered';
    }
  | {
      /** Body rejected before anything was reserved or posted. */
      kind: 'invalidRequest';
      /** The endpoint's own validation message. Never a forwarded error. */
      reason?: string;
    }
  | {
      /**
       * The destination is unusable, so nothing was reserved and nothing was
       * posted: no target configured, or one that failed the egress guard (not
       * HTTPS, host off the allowlist, or no allowlist configured - which fails
       * closed by design, and is every consumer's first-run state).
       *
       * The guard runs BEFORE the reserve, so this never leaves a reservation
       * behind, and it is a configuration error rather than an ambiguous post -
       * the "an unclassified throw counts as unknown, therefore hold" rule MUST
       * NOT be applied to it.
       */
      kind: 'targetRejected';
      /**
       * Which check failed. MUST NOT include the rejected value: the guard is
       * handed the whole target, so echoing it back returns the credential.
       */
      reason?: string;
    }
  | {
      /**
       * The dedupe store could not confirm the reservation, so the send was
       * refused WITHOUT posting. Send fails CLOSED here, deliberately against
       * this capability's usual direction: continuing past an unconfirmed reserve
       * means posting with no reservation at all, so one double-click during a
       * store failover posts twice. A delayed digest is recoverable; a
       * double-pinged channel is not.
       *
       * Nothing was posted - certain, because the post is downstream of the
       * reserve. Whether a reservation LANDED is not certain: a reserve that
       * timed out may still have been written, leaving an `inFlight` entry nobody
       * owns, so a retry inside the window reads it and gets 'deliveryUnknown'
       * until the TTL clears it.
       */
      kind: 'dedupeUnavailable';
    };

/** Tokens the proofreading preview renders. */
export type MarkupToken =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; name: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string };
