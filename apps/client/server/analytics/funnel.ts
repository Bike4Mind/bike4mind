import type { Request } from 'express';
import type { IUserAcquisition } from '@bike4mind/common';
import { adminSettingsRepository, User, userRepository } from '@bike4mind/database';
import type { AcquisitionTouches } from '@client/lib/subscriptions/acquisition';
import { readConsentedAcquisitionTouches } from './acquisition';
import { emitProductEvent, HOST_PRODUCT_ID } from './emitActiveEvent';
import { pseudonymizeUserId } from './pseudonymize';
import { stableEventId } from './signupEvents';

// Server half of the funnel instrumentation. The client half (begin_checkout, upsell_*) is
// app/utils/funnelEvents.ts; both skip users flagged isSynthetic so test personas never reach
// conversion metrics.

export const SYNTHETIC_USERNAME_PREFIX = 'persona-';

/** Lower-cased domains from a comma/whitespace separated list; leading `@` tolerated. */
export function parseDomainList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,]+/)
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/** Whether an account is a test persona: the username prefix, or an email on (or under) a test domain. */
export function isSyntheticIdentity(
  identity: { username?: string | null; email?: string | null },
  testDomains: readonly string[]
): boolean {
  if (identity.username?.toLowerCase().startsWith(SYNTHETIC_USERNAME_PREFIX)) return true;
  const domain = identity.email?.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return testDomains.some(d => domain === d || domain.endsWith(`.${d}`));
}

async function syntheticTestDomains(): Promise<string[]> {
  try {
    return parseDomainList(await adminSettingsRepository.getSettingsValue('syntheticUserEmailDomains'));
  } catch {
    return [];
  }
}

/** The user-record shape of the touches, or undefined when there is no touch to keep. */
export function toUserAcquisition(
  touches: AcquisitionTouches,
  signupMethod: string,
  now: Date = new Date()
): IUserAcquisition | undefined {
  if (!touches.firstTouch && !touches.lastTouch) return undefined;
  return {
    ...(touches.firstTouch && { firstTouch: touches.firstTouch }),
    ...(touches.lastTouch && { lastTouch: touches.lastTouch }),
    signupMethod,
    capturedAt: now,
  };
}

/**
 * Persist the signup's consented acquisition touches and the synthetic flag on the new user.
 * Consent is the same server-side gate signup pixels and Overwatch signup credit use
 * (readConsentedAcquisitionTouches), so a declined or unanswered consent stores no touch.
 * Never throws: a signup must not fail on analytics. Resolves to what was decided.
 */
export async function recordSignupAcquisition(opts: {
  req: Pick<Request, 'headers'>;
  user: { id: string; username?: string | null; email?: string | null };
  method: string;
}): Promise<{ acquisition?: IUserAcquisition; isSynthetic: boolean }> {
  try {
    const acquisition = toUserAcquisition(readConsentedAcquisitionTouches(opts.req), opts.method);
    const isSynthetic = isSyntheticIdentity(opts.user, await syntheticTestDomains());
    if (acquisition || isSynthetic) {
      await userRepository.update({
        id: opts.user.id,
        ...(acquisition && { acquisition }),
        ...(isSynthetic && { isSynthetic: true }),
      });
    }
    return { ...(acquisition && { acquisition }), isSynthetic };
  } catch (err) {
    console.warn('[b4m-analytics] signup acquisition not recorded', err instanceof Error ? err.message : err);
    return { isSynthetic: false };
  }
}

export type FunnelUser = {
  id: string;
  isSynthetic?: boolean | null;
  acquisition?: Pick<IUserAcquisition, 'firstTouch'> | null;
};

// first_value counts only users who sign up after the funnel ships; no backfill. Without it every
// pre-existing user (firstValueAt unset) would emit on their next answer.
export const FIRST_VALUE_LAUNCH_AT = new Date('2026-10-11T00:00:00Z');

/** Whether the account was created on or after launch; a missing or unparseable createdAt is not. */
function signedUpAfterLaunch(createdAt: Date | string | null | undefined): boolean {
  const ms = createdAt ? new Date(createdAt).getTime() : NaN;
  return Number.isFinite(ms) && ms >= FIRST_VALUE_LAUNCH_AT.getTime();
}

export type FunnelEvent = 'credits_granted' | 'email_verified' | 'first_value';

/**
 * One once-per-user funnel stage to Overwatch under the host product. The eventId is keyed on the
 * user's pseudonym, so a retried handler sends the same id and the receiver keeps one event. The
 * campaign is the stored first touch, not the 30-minute session cookie, so later stages stay
 * joinable to the door the user came through. Synthetic users are skipped. Never throws.
 * Resolves to whether an emit was attempted.
 */
export async function emitFunnelEvent(opts: {
  user: FunnelUser;
  event: FunnelEvent;
  metadata?: Record<string, string | number | boolean>;
}): Promise<boolean> {
  if (opts.user.isSynthetic) return false;
  const utm = opts.user.acquisition?.firstTouch;
  await emitProductEvent({
    productId: HOST_PRODUCT_ID,
    event: opts.event,
    eventId: stableEventId(opts.event, HOST_PRODUCT_ID, pseudonymizeUserId(opts.user.id)),
    userId: opts.user.id,
    ...(utm && { utm }),
    ...(opts.metadata && { metadata: opts.metadata }),
  }).catch(() => {});
  return true;
}

/**
 * Mark the user's first completed chat answer and emit `first_value` once. The conditional update
 * is what makes it once: only the request that flips firstValueAt from unset emits, so concurrent
 * completions cannot double-count. Callers skip this when the loaded user already has
 * firstValueAt, which keeps the steady-state cost at zero writes. Users created before
 * FIRST_VALUE_LAUNCH_AT are skipped. Never throws.
 */
export async function recordFirstValue(opts: {
  user: FunnelUser & { createdAt?: Date | string | null };
  feature: string;
  now?: Date;
}): Promise<boolean> {
  if (!signedUpAfterLaunch(opts.user.createdAt)) return false;
  try {
    const now = opts.now ?? new Date();
    const res = await User.updateOne({ _id: opts.user.id, firstValueAt: null }, { $set: { firstValueAt: now } });
    if (res.modifiedCount !== 1) return false;
    const createdAt = opts.user.createdAt ? new Date(opts.user.createdAt).getTime() : NaN;
    return await emitFunnelEvent({
      user: opts.user,
      event: 'first_value',
      metadata: {
        feature: opts.feature,
        ...(Number.isFinite(createdAt) && {
          secondsSinceSignup: Math.max(0, Math.round((now.getTime() - createdAt) / 1000)),
        }),
      },
    });
  } catch (err) {
    console.warn('[b4m-analytics] first_value not recorded', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * The chat path's first_value hook, called after a quest finishes processing. A user who already
 * has firstValueAt costs nothing; otherwise the quest is read once and only a completed answer
 * counts - a stopped turn is not value, and neither is a failed one, which still ends `done` but
 * with `type: 'error'` (out of credits, provider failure; see ChatQuestPollResultSchema in
 * @bike4mind/common schemas/chat.ts). Never throws.
 */
export async function recordFirstChatValue(opts: {
  user: FunnelUser & { createdAt?: Date | string | null; firstValueAt?: Date | null };
  loadQuest: () => Promise<{ status?: string; type?: string } | null | undefined>;
}): Promise<boolean> {
  if (opts.user.firstValueAt || !signedUpAfterLaunch(opts.user.createdAt)) return false;
  const quest = await opts.loadQuest().catch(() => undefined);
  if (quest?.status !== 'done' || quest.type === 'error') return false;
  return recordFirstValue({ user: opts.user, feature: 'chat' });
}
