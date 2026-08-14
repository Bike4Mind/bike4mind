/**
 * PR report generator - Slack adapter.
 *
 * This deliberately does NOT go through `SlackClient`, which is the repo's usual
 * Slack entry point. Two of its behaviours are disqualifying for this capability:
 *
 *  1. `sendMessage` collapses every failure into `null`. The send dedupe's release
 *     rule turns on exactly one distinction - did the provider accept the post or
 *     not - and a caller that cannot read it has to guess. Both guesses are wrong:
 *     always releasing re-opens the double-post window, always holding wedges a send
 *     for a full TTL after a plain connection refusal.
 *  2. `MAX_TEXT_LENGTH` is 4000 and `sendMessage` silently truncates to it. A digest
 *     covering ~36 open PRs runs well past that, so the channel would receive a
 *     report cut off mid-section that still reads as complete. Slack's actual
 *     `chat.postMessage` text limit is 40,000.
 *
 * So the two ports below drive `WebClient` directly, classify failures, and never
 * truncate.
 */

import { ErrorCode, WebClient } from '@slack/web-api';
import type { Logger } from '@bike4mind/observability';
import type { ChatMemberId, ChatMemberNameResult, ChatPostTarget, PostDelivery, PostResult } from '@bike4mind/services';

/** Bounded so a stalled Slack cannot hold the request open to the Lambda's limit. */
const POST_TIMEOUT_MS = 10_000;
const MEMBER_LOOKUP_TIMEOUT_MS = 6_000;
/** Modest fan-out: enough to resolve a digest's mentions inside the budget. */
const MEMBER_LOOKUP_CONCURRENCY = 4;

/** Anything token-shaped, in case a provider error echoes the credential back. */
const TOKEN_PATTERN = /xox[abposr]-[A-Za-z0-9-]+/g;

/**
 * Reduce a provider error to server-side-loggable detail.
 *
 * Even though this never crosses the wire (the send endpoint's `notDelivered` arm
 * carries no `reason` field at all), it is still scrubbed before it reaches a log:
 * Slack errors routinely echo request context, and a bot token in a log line is a
 * bearer-equivalent secret sitting in log retention.
 */
function scrubReason(error: unknown): string {
  const parts: string[] = [];
  const code = (error as { code?: string }).code;
  const status = (error as { statusCode?: number }).statusCode;
  const slackError = (error as { data?: { error?: string } }).data?.error;

  if (code) parts.push(`code=${code}`);
  if (typeof status === 'number') parts.push(`status=${status}`);
  if (slackError) parts.push(`slackError=${slackError}`);
  if (!parts.length && error instanceof Error) parts.push(error.message.replace(TOKEN_PATTERN, '[redacted]'));

  return parts.join(' ') || 'unclassified post failure';
}

/**
 * Decide whether a failed post definitely never landed, or might have.
 *
 * The asymmetry drives every judgement here: a wrong `unknown` costs one held
 * reservation for the TTL, while a wrong `notDelivered` re-pings the entire channel.
 * So the `notDelivered` set is a deliberate whitelist and EVERYTHING unrecognized
 * falls through to `unknown`.
 */
function classifyPostFailure(error: unknown): PostDelivery {
  const code = (error as { code?: string }).code;

  // Slack answered and declined - `ok: false` with an error string, or a 429. The
  // body was read and refused, so nothing was posted.
  if (code === ErrorCode.PlatformError) return 'notDelivered';
  if (code === ErrorCode.RateLimitedError) return 'notDelivered';

  if (code === ErrorCode.HTTPError) {
    const status = (error as { statusCode?: number }).statusCode;
    // 4xx: Slack responded before accepting the body. 5xx: it may have accepted the
    // post and then failed on the way back.
    if (typeof status === 'number' && status >= 400 && status < 500) return 'notDelivered';
    return 'unknown';
  }

  if (code === ErrorCode.RequestError) {
    const cause = (error as { original?: { code?: string } }).original?.code;
    // Never transmitted: name resolution, refused connection, or a rejected
    // certificate. A retry cannot duplicate what was never sent.
    const definitelyNotSent = [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ];
    if (cause && definitelyNotSent.includes(cause)) return 'notDelivered';
    // ECONNRESET, ETIMEDOUT, ECONNABORTED and friends: transmitted, outcome unknown.
    return 'unknown';
  }

  // Unrecognized - including an AbortError from our own timeout, which is precisely
  // the case that must hold rather than release.
  return 'unknown';
}

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

/**
 * Post the final, human-approved text.
 *
 * NON-IDEMPOTENT: a post Slack already accepted can still time out. No retry or
 * backoff is applied here - that would be the double-post the send dedupe exists to
 * prevent. Delivery is at-least-once and the endpoint dedupes.
 */
export function createPostReport(logger: Logger) {
  return async function postReport(text: string, destination: ChatPostTarget): Promise<PostResult> {
    const client = new WebClient(destination.token, { timeout: POST_TIMEOUT_MS, retryConfig: { retries: 0 } });

    try {
      const result = await withTimeout(
        client.chat.postMessage({
          channel: destination.channel,
          text,
          // The digest is pre-rendered mrkdwn with its own escaping; Slack must not
          // second-guess it by linkifying names or channels.
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false,
        }),
        POST_TIMEOUT_MS,
        'Slack chat.postMessage'
      );

      if (result.ok) return { accepted: true };

      // `ok: false` without a thrown error: Slack answered and declined.
      return { accepted: false, delivery: 'notDelivered', reason: scrubReason(result) };
    } catch (error) {
      const delivery = classifyPostFailure(error);
      const reason = scrubReason(error);

      // Logged server-side only. Never returned to the client - for a webhook-style
      // credential the URL *is* the authentication, and the same rule is applied to
      // the bot token here.
      logger.error('[PrReport] Slack post failed', { delivery, reason, channel: destination.channel });

      return { accepted: false, delivery, reason };
    }
  };
}

/**
 * Resolve Slack member ids to display names for the proofreading preview.
 *
 * ENRICHMENT: bounded, and ANY failure degrades to `{ names: {}, available: false }`
 * rather than rejecting - a preview showing raw member ids is honest, a failed
 * generate is not.
 *
 * The availability flag is NOT derivable from the map. A partial map from a healthy
 * lookup (a deactivated member) and a partial map from one cut short by a timeout are
 * byte-identical, so `available` distinguishes "could not resolve that id" from
 * "the lookup broke".
 *
 * Runs SERVER-SIDE only. The bot token is bearer-equivalent and must never reach the
 * browser, which is why there is no client-side lookup and the names are shipped on
 * the generate response instead.
 */
export function createFetchChatMemberNames(logger: Logger, token: string | null | undefined) {
  return async function fetchChatMemberNames(memberIds: ChatMemberId[]): Promise<ChatMemberNameResult> {
    if (!memberIds.length) return { names: {}, available: true };
    if (!token) {
      // A post-only credential has no read scope at all. An honest degradation, and
      // the DEFAULT for the simplest binding rather than an exotic edge case.
      logger.warn('[PrReport] Member-name lookup skipped - no Slack read credential configured');
      return { names: {}, available: false };
    }

    const client = new WebClient(token, {
      timeout: MEMBER_LOOKUP_TIMEOUT_MS,
      retryConfig: { retries: 0 },
    });

    const names: Record<ChatMemberId, string> = {};
    let degraded = false;

    // User groups (S...) are pinged via the subteam form but cannot be resolved by
    // users.info; querying one risks a spurious error that would falsely mark the whole
    // lookup degraded. Resolving group display names needs usergroups.list (deferred), so
    // group mentions render with their raw id in the preview - honest, like an unmapped
    // user. Filtering here, not in the core extractor, keeps that knowledge with the
    // adapter that actually calls users.info.
    const queue = memberIds.filter(id => !id.startsWith('S'));
    const workers = Array.from({ length: Math.min(MEMBER_LOOKUP_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const result = await client.users.info({ user: id });
          const user = result.ok ? result.user : undefined;
          if (user) {
            names[id] = user.real_name || user.profile?.display_name || user.name || id;
          } else {
            // `ok: false` for a single id - user_not_found, or a deactivated member.
            // A legitimate absence, not a broken lookup.
            const slackError = (result as { error?: string }).error;
            if (slackError && slackError !== 'user_not_found') degraded = true;
          }
        } catch (error) {
          const slackError = (error as { data?: { error?: string } }).data?.error;
          // Same distinction on the thrown path: an id that does not resolve is
          // ordinary; anything else means the lookup itself is unhealthy.
          if (slackError === 'user_not_found') continue;
          degraded = true;
          logger.warn('[PrReport] Member-name lookup degraded', { reason: scrubReason(error) });
        }
      }
    });

    try {
      await withTimeout(Promise.all(workers), MEMBER_LOOKUP_TIMEOUT_MS * 2, 'Slack member-name lookup');
    } catch (error) {
      // Cut short mid-batch: return what resolved, flagged unavailable.
      logger.warn('[PrReport] Member-name lookup timed out', { reason: scrubReason(error) });
      degraded = true;
    }

    return { names, available: !degraded };
  };
}
