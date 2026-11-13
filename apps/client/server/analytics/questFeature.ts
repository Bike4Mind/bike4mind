import type { Request } from 'express';
import { z } from 'zod';
import { hasDeveloperUserTag, OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { emitProductEvent, HOST_PRODUCT_ID } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { INTERNAL_MARK, laneMetadata } from '@bike4mind/server-utils/analytics/lane';
import { readVisitId } from './visitSession';

// The log-event route's bridge to Overwatch's Rounds, a quest game for the team: a quest card names
// an event, by default this one with a `metadata.feature`, and Overwatch checks the card off when the
// player's own event arrives. Forwarding the route's UI actions lets a card name any of them as its
// feature with no change here.

/** The event a Rounds card waits for unless it names another. */
export const QUEST_FEATURE_EVENT = 'quest_feature_used';

/** The user tag that opens Rounds. */
const ROUNDS_USER_TAG = 'rounds';

/** One event per user and feature per this long (ms), per server instance: a card needs only one. */
const QUEST_FEATURE_THROTTLE_MS = 10 * 60 * 1000;

/** The most (user, feature) pairs the throttle holds. Rounds is for the team, so this is never near. */
export const QUEST_FEATURE_THROTTLE_MAX = 1_000;

/** A feature as Overwatch takes a card's feature key: lowercase letters, digits and underscores. */
const QUEST_FEATURE_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * This event's metadata fields, in the shape the emitter's metadata allowlist takes as
 * `metadataFields`. That allowlist keeps only declared fields, and the host's own vocabulary takes
 * `feature` only as first_value's `'chat'`, so without this every quest event would lose its
 * feature. The shared marks (`internal`, `lane`) are the emitter's to validate. An emitter without
 * the allowlist ignores it.
 */
export const QUEST_FEATURE_METADATA_FIELDS = { feature: z.string().regex(QUEST_FEATURE_PATTERN) } as const;

// `${userId}:${feature}` -> when it was last sent (ms). Module scope, so every request this instance
// serves shares it. A send re-inserts its key, so iteration order is oldest send first.
const lastSent = new Map<string, number>();

/** Test-only: clear the throttle between cases. */
export function __resetQuestFeatureThrottle(): void {
  lastSent.clear();
}

/**
 * Whether this request may send `quest_feature_used`, and claims the slot when it may. Claimed
 * before the emit, so two requests in flight together send one event. A full map drops its oldest
 * entry, which at worst lets that pair send again early.
 */
function claimThrottleSlot(key: string, now: number): boolean {
  const at = lastSent.get(key);
  if (at !== undefined && now - at < QUEST_FEATURE_THROTTLE_MS) return false;
  lastSent.delete(key);
  if (lastSent.size >= QUEST_FEATURE_THROTTLE_MAX) {
    const oldest = lastSent.keys().next().value;
    if (oldest !== undefined) lastSent.delete(oldest);
  }
  lastSent.set(key, now);
  return true;
}

/**
 * Whether the request's user plays Rounds. Must stay in step with Overwatch's own Rounds gate,
 * `requestHasRoundsAccess`, which the `/rounds` page's `requireFeatureTag` also matches: a human
 * session only (an API key is refused whoever owns it), whose user is an admin, carries a developer
 * tag (`hasDeveloperUserTag`, case-sensitive), or carries the `rounds` tag compared lowercased and
 * never trimmed. Nobody else's UI actions are forwarded.
 */
export function hasRoundsAccess<R extends Pick<Request, 'user' | 'apiKeyInfo'>>(
  req: R
): req is R & { user: NonNullable<R['user']> } {
  if (req.apiKeyInfo) return false;
  const user = req.user;
  if (!user) return false;
  return (
    !!user.isAdmin ||
    hasDeveloperUserTag(user.tags) ||
    (user.tags ?? []).some(tag => tag.toLowerCase() === ROUNDS_USER_TAG)
  );
}

/**
 * The `metadata.feature` for a UI event type: lowercased, each run of anything but a letter or digit
 * made one underscore, and none left at either end. `'AI Image Generated'` is `ai_image_generated`,
 * `'Auto-Named Session Started'` is `auto_named_session_started`, and a snake-case type is unchanged.
 * Quest cards name features by this value, so it must not change for any type that exists.
 */
export function questFeatureName(type: string): string {
  return type
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Forwards a UI action the log-event route has recorded to Overwatch as `quest_feature_used`, for a
 * Rounds player only (hasRoundsAccess). Sent under the host product, with the user's pseudonym and
 * the request's visit, as core's other Overwatch events are, plus the account's lane marks and
 * `internal: true` whatever the lane: these events exist only for Rounds.
 *
 * Every type the route accepts is forwarded, so its type check is the only filter. A player can post
 * a type without doing the action, as with any event a browser sends.
 *
 * At most once per user and feature per QUEST_FEATURE_THROTTLE_MS on this instance, so a busy
 * player cannot use up the ingest rate limit the host key's other events share.
 *
 * Never throws: a failure is logged and dropped. Awaited by the route, as the funnel's emits are, so
 * nothing runs on after the response; the emitter's own timeout bounds the wait.
 */
export async function forwardQuestFeature(
  req: Pick<Request, 'user' | 'apiKeyInfo' | 'headers'>,
  type: string,
  now: number = Date.now()
): Promise<void> {
  try {
    if (!hasRoundsAccess(req)) return;
    const feature = questFeatureName(type);
    if (!QUEST_FEATURE_PATTERN.test(feature)) return;
    if (!claimThrottleSlot(`${req.user.id}:${feature}`, now)) return;
    // Built apart from the call so `metadataFields` passes type checks against an emitter that does
    // not declare it yet.
    const options = {
      productId: HOST_PRODUCT_ID,
      event: QUEST_FEATURE_EVENT,
      userId: req.user.id,
      sessionId: readVisitId(req.headers.cookie) ?? OVERWATCH_UNKNOWN_SESSION_ID,
      metadata: { feature, ...laneMetadata(req.user), [INTERNAL_MARK]: true },
      metadataFields: QUEST_FEATURE_METADATA_FIELDS,
    };
    await emitProductEvent(options);
  } catch (err) {
    Logger.warn('[b4m-analytics] quest feature not forwarded', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
