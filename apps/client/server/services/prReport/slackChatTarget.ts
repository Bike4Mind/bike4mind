/**
 * PR report generator - Slack adapter.
 *
 * The post path is a direct `fetch` to a Slack Incoming Webhook URL. It deliberately
 * does NOT go through `SlackClient`, the repo's usual Slack entry point, whose
 * `sendMessage` collapses every failure into `null` (the send dedupe's release rule
 * turns on exactly the accepted-vs-not distinction that erases) and silently truncates
 * at `MAX_TEXT_LENGTH` 4000 (a ~36-PR digest runs well past that, so the channel would
 * get a report cut off mid-section that still reads as complete). So the poster reads
 * the HTTP result itself, classifies failures, and never truncates.
 *
 * The member-name lookup below still drives `WebClient` directly, because it needs a
 * read scope (`users.info`) that a webhook does not carry - it runs off the optional
 * workspace bot token instead.
 */

import { WebClient } from '@slack/web-api';
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
 * An incoming-webhook URL or its secret `/services/T.../B.../...` tail, in case a
 * network error echoes the destination. The URL is bearer-equivalent, so it must not
 * reach a log line any more than a bot token may.
 */
const WEBHOOK_URL_PATTERN = /(https?:\/\/\S*)?\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/\S+/g;

function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, '[redacted]').replace(WEBHOOK_URL_PATTERN, '[redacted-webhook]');
}

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
  if (!parts.length && error instanceof Error) parts.push(redactSecrets(error.message));

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
  // Node fetch (undici) surfaces the socket-level failure on `error.cause`; our own
  // timeout is a plain Error with no code.
  const cause = (error as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (error as { code?: string }).code;

  // Never transmitted: name resolution, refused connection, or a rejected certificate.
  // A retry cannot duplicate what was never sent, so the reservation is safe to release.
  const definitelyNotSent = [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ];
  if (code && definitelyNotSent.includes(code)) return 'notDelivered';

  // Everything else - a reset or timeout after the bytes left, our own abort, or an
  // unrecognized error - MIGHT have landed, so hold rather than release.
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
 * Post the final, human-approved text to the incoming webhook.
 *
 * NON-IDEMPOTENT: a post Slack already accepted can still time out. No retry or
 * backoff is applied here - that would be the double-post the send dedupe exists to
 * prevent. Delivery is at-least-once and the endpoint dedupes.
 */
export function createPostReport(logger: Logger) {
  return async function postReport(text: string, destination: ChatPostTarget): Promise<PostResult> {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await withTimeout(
        // Incoming webhooks take the message JSON; the digest is pre-rendered, pre-escaped
        // mrkdwn, and webhooks render `text` as mrkdwn by default.
        fetch(destination.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }),
        POST_TIMEOUT_MS,
        'Slack incoming webhook'
      );
    } catch (error) {
      const delivery = classifyPostFailure(error);
      const reason = scrubReason(error);
      // Server-side only. Never returned to the client and never naming the URL - the
      // webhook URL is the authentication.
      logger.error('[PrReport] Slack webhook post failed', { delivery, reason });
      return { accepted: false, delivery, reason };
    }

    // A 2xx (webhooks answer 200 with the body "ok") is acceptance.
    if (response.ok) return { accepted: true };

    // 4xx: Slack read the request and declined it, so nothing was posted and the
    // reservation is safe to release. 5xx: it may have accepted the body and then failed
    // on the way back, so hold. Status only - the body may echo the destination.
    const delivery: PostDelivery = response.status >= 400 && response.status < 500 ? 'notDelivered' : 'unknown';
    const reason = `status=${response.status}`;
    logger.error('[PrReport] Slack webhook rejected the post', { delivery, reason });
    return { accepted: false, delivery, reason };
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
