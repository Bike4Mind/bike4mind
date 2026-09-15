/**
 * PR report generator - the send half of the two-phase flow.
 *
 * Takes the FINAL, human-edited text and posts it. Because posting is
 * non-idempotent - a post Slack already accepted can still time out - this guards
 * against repeat delivery as well as bad content, via an atomic
 * reserve-before-post against the shared dedupe store.
 *
 * The ordering below is load-bearing and each step's failure has its own terminal
 * shape. In particular the egress guard runs BEFORE the reserve and must not be
 * swept into the hold-on-anything-unclassified rule that governs the post: it is a
 * configuration error with no reservation behind it, and wrapping guard and post in
 * one `catch` wedges a provably-unposted digest for a full TTL.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ChatPostTarget, PostResult, SendReportFailure, SendReportResponse, SendReservation } from './types';
import type { AssertChatTargetFormat, PostReport, PrReportMetrics, SendDedupeStore } from './ports';

/**
 * Slack's `chat.postMessage` text limit. Text above this is rejected as an
 * invalid request rather than silently truncated - a digest cut mid-section would
 * post a report that reads as complete.
 */
export const MAX_SEND_TEXT_LENGTH = 40_000;

/**
 * The dedupe window. Long enough to absorb a double-click or a client retry, and
 * comfortably longer than the post timeout so the stale-submit race stays off the
 * routine path.
 */
export const SEND_DEDUPE_TTL_MS = 10 * 60 * 1000;

export interface SendReportDeps {
  postReport: PostReport;
  assertChatTargetFormat: AssertChatTargetFormat;
  dedupeStore: SendDedupeStore;
  metrics: PrReportMetrics;
}

export interface SendReportParams {
  text: string;
  /** Repo identifier, part of the fallback dedupe key. */
  repo: string;
  destination: ChatPostTarget | null | undefined;
  idempotencyKey?: string;
  ttlMs?: number;
}

export type SendReportOutcome = { ok: true; response: SendReportResponse } | { ok: false; failure: SendReportFailure };

/**
 * The dedupe key. The client-supplied idempotency key is preferred because it is
 * exact - it identifies THIS submit attempt, so it distinguishes a retry from a
 * deliberate identical re-send. The (text, repo) hash is the fallback: it
 * over-matches, which is the safer direction, but it also has no escape from a held
 * reservation, since the key is a function of the text.
 */
function dedupeKeyFor(params: SendReportParams): string {
  if (params.idempotencyKey) {
    return `prReport:send:key:${createHash('sha256').update(params.idempotencyKey).digest('hex')}`;
  }
  // NUL separator, written as an escape so the file stays ASCII and greppable. A
  // delimiter that cannot occur in either field is what keeps the hash unambiguous:
  // with a space, ('a b', 'c') and ('a', 'b c') would collide onto one dedupe key and
  // a legitimate send would be absorbed as a duplicate of an unrelated one.
  const digest = createHash('sha256').update(`${params.repo}\x00${params.text}`).digest('hex');
  return `prReport:send:hash:${digest}`;
}

/**
 * Call the post port, converting a THROW into `delivery: 'unknown'`.
 *
 * The whitelist is deliberate: anything unclassified HOLDS the reservation. The
 * likeliest source of an unclassified throw is the timeout wrapper, which is
 * precisely the case that must not release - a naive `catch` gets this polarity
 * backwards and re-pings the whole channel on the retry.
 */
async function postOrClassifyAsUnknown(
  postReport: PostReport,
  text: string,
  destination: ChatPostTarget
): Promise<PostResult> {
  try {
    return await postReport(text, destination);
  } catch (error) {
    return {
      accepted: false,
      delivery: 'unknown',
      reason: error instanceof Error ? error.message : 'post threw a non-Error',
    };
  }
}

export async function sendReport(params: SendReportParams, deps: SendReportDeps): Promise<SendReportOutcome> {
  const ttlMs = params.ttlMs ?? SEND_DEDUPE_TTL_MS;

  // 1. Body validation. Before anything is reserved or posted.
  if (!params.text?.trim()) {
    return { ok: false, failure: { kind: 'invalidRequest', reason: 'text is empty' } };
  }
  if (params.text.length > MAX_SEND_TEXT_LENGTH) {
    return {
      ok: false,
      failure: {
        kind: 'invalidRequest',
        reason: `text exceeds ${MAX_SEND_TEXT_LENGTH} characters`,
      },
    };
  }

  // 2. Egress guard, in its own try so its rejection cannot be mistaken for an
  //    ambiguous post. Its message names the failed check and never echoes the
  //    target - the guard is handed the whole credential.
  try {
    deps.assertChatTargetFormat(params.destination);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'targetRejected',
        reason: error instanceof Error ? error.message : 'destination rejected',
      },
    };
  }
  // Narrowed by the guard, which throws on a missing destination.
  const destination = params.destination as ChatPostTarget;

  const key = dedupeKeyFor(params);
  const ownerToken = randomUUID();
  const reservation: SendReservation = { state: 'inFlight', ownerToken };

  // 3. Atomic reserve BEFORE the post. A check-then-post that records the key only
  //    after a successful post still races: two concurrent submits both read
  //    "absent" and both post.
  let reserved: boolean;
  try {
    const attempt = await deps.dedupeStore.reserve(key, reservation, ttlMs);
    reserved = attempt.reserved;
  } catch (error) {
    // FAIL CLOSED - the one place this capability does. Continuing past an
    // unconfirmed reserve is not a degraded dedupe, it is NO dedupe, so a
    // double-click during a store failover posts twice. A delayed digest is
    // recoverable; a double-pinged channel is not.
    deps.metrics.increment('prReport.dedupeReserveUnavailable', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { ok: false, failure: { kind: 'dedupeUnavailable' } };
  }

  if (!reserved) {
    const classified = await classifyExistingReservation(key, reservation, ttlMs, deps);
    if (classified.kind === 'respond') return classified.outcome;
    // 'proceed' - the key turned out to be free and we now own it.
  }

  // 4. Post.
  const result = await postOrClassifyAsUnknown(deps.postReport, params.text, destination);

  if (result.accepted) {
    try {
      const stillOurs = await deps.dedupeStore.markDelivered(key, ownerToken);
      if (!stillOurs) {
        // The CONDITION was not met: our reservation expired and a different submit
        // owns the key now. We cannot know what that owner did, so we must not claim
        // its delivery - even though our own post was accepted.
        deps.metrics.increment('prReport.deliveryUnknown', { cause: 'flipLostOwnership' });
        return { ok: true, response: { outcome: 'deliveryUnknown' } };
      }
    } catch (error) {
      // The WRITE ITSELF errored - a different event from losing ownership. The
      // reservation is not lost, only unwritten, and THIS call watched the delivery
      // happen, so it honestly reports 'sent'. The entry stays `inFlight`, so later
      // retries get the conservative 'deliveryUnknown' until the TTL clears it.
      deps.metrics.increment('prReport.dedupeWriteFailed', {
        operation: 'markDelivered',
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return { ok: true, response: { outcome: 'sent' } };
  }

  if (result.delivery === 'notDelivered') {
    // Definite non-delivery: Slack did not accept the post, so a retry cannot
    // duplicate anything. This is the ONLY condition that releases.
    try {
      const stillOurs = await deps.dedupeStore.release(key, ownerToken);
      if (!stillOurs) {
        deps.metrics.increment('prReport.deliveryUnknown', { cause: 'releaseLostOwnership' });
        return { ok: true, response: { outcome: 'deliveryUnknown' } };
      }
    } catch (error) {
      // Release errored: still report the failed send. The entry we could not delete
      // simply expires with its TTL, and a retry inside the window gets
      // 'deliveryUnknown' first.
      deps.metrics.increment('prReport.dedupeWriteFailed', {
        operation: 'release',
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    // The provider's reason is logged by the adapter, never returned - this arm
    // deliberately carries no `reason` field at all.
    return { ok: false, failure: { kind: 'notDelivered' } };
  }

  // Ambiguous: the request was transmitted and the outcome was not. HOLD the
  // reservation for its full TTL. This is the case the whole mechanism exists for -
  // a timeout is a failed post from our side, and releasing on it would let the
  // client's retry find the key absent and re-ping the entire channel.
  deps.metrics.increment('prReport.deliveryUnknown', { cause: 'ambiguousPost' });
  return { ok: true, response: { outcome: 'deliveryUnknown' } };
}

/**
 * Classify a reservation we failed to claim.
 *
 * THREE possible answers, not two. The third - absent - is reachable because a
 * concurrent submit can release the key between our failed reserve and this read
 * (the release rule deletes on definite non-delivery), and because the TTL can lapse
 * in the same gap.
 *
 * An absent read MUST NOT fall through to 'deduped': that would assert a delivery
 * that provably did not happen, hand the caller a 200, and leave the digest unsent
 * with the audit log recording success. (`state === 'inFlight' ? … : 'deduped'` is
 * the natural one-liner here, and it is exactly the bug.)
 */
async function classifyExistingReservation(
  key: string,
  reservation: SendReservation,
  ttlMs: number,
  deps: SendReportDeps
): Promise<{ kind: 'proceed' } | { kind: 'respond'; outcome: SendReportOutcome }> {
  let existing: SendReservation | null;
  try {
    existing = await deps.dedupeStore.read(key);
  } catch (error) {
    deps.metrics.increment('prReport.dedupeReserveUnavailable', {
      operation: 'read',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { kind: 'respond', outcome: { ok: false, failure: { kind: 'dedupeUnavailable' } } };
  }

  if (existing === null) {
    // Nobody holds the key. Re-attempt the reserve ONCE and, if it succeeds, post
    // normally; only a second failed reserve falls through to classification.
    try {
      const retry = await deps.dedupeStore.reserve(key, reservation, ttlMs);
      if (retry.reserved) return { kind: 'proceed' };

      if (retry.existing?.state === 'delivered') {
        return { kind: 'respond', outcome: { ok: true, response: { outcome: 'deduped' } } };
      }
      // In flight, or unreadable. Either way we cannot claim a delivery.
      deps.metrics.increment('prReport.deliveryUnknown', { cause: 'reReserveRaced' });
      return { kind: 'respond', outcome: { ok: true, response: { outcome: 'deliveryUnknown' } } };
    } catch (error) {
      deps.metrics.increment('prReport.dedupeReserveUnavailable', {
        operation: 'reReserve',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return { kind: 'respond', outcome: { ok: false, failure: { kind: 'dedupeUnavailable' } } };
    }
  }

  if (existing.state === 'delivered') {
    // An honest claim: the earlier send landed, so nothing was posted on this call.
    return { kind: 'respond', outcome: { ok: true, response: { outcome: 'deduped' } } };
  }

  // `inFlight` - a concurrent submit whose post has not come back, or one held from
  // an earlier ambiguous outcome. It cannot honestly claim "the earlier send
  // delivered", so the admin is told to check the channel before retrying.
  deps.metrics.increment('prReport.deliveryUnknown', { cause: 'readInFlight' });
  return { kind: 'respond', outcome: { ok: true, response: { outcome: 'deliveryUnknown' } } };
}
