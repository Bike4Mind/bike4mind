import type { Request } from 'express';
import {
  FirstRunEvents,
  isSyntheticIdentity,
  parseSyntheticDomainList,
  type IUserAcquisition,
} from '@bike4mind/common';
import { adminSettingsRepository, User, userRepository } from '@bike4mind/database';
import type { AcquisitionTouches } from '@bike4mind/server-utils/lib/subscriptions/acquisition';
import { readConsentedAcquisitionTouches } from './acquisition';
import { emitProductEvent, HOST_PRODUCT_ID } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { laneMetadata } from '@bike4mind/server-utils/analytics/lane';
import { pseudonymizeUserId } from '@bike4mind/server-utils/analytics/pseudonymize';
import { stableEventId } from './signupEvents';
import { logEventSafe } from '@bike4mind/server-utils/utils/analyticsLog';
import { rewardInviterForFirstAnswer } from '@server/referrals/firstAnswerReward';

// Server half of the funnel instrumentation. The client half (begin_checkout, upsell_*) is
// app/utils/funnelEvents.ts. Users flagged isSynthetic are handled differently by each: the client
// half feeds GA4 and ad pixels, which have no way to set a test persona aside, so it skips them;
// this half feeds Overwatch, which can tell them apart, so it sends them marked with the synthetic
// lane (lane.ts).

async function syntheticTestDomains(): Promise<string[]> {
  try {
    return parseSyntheticDomainList(await adminSettingsRepository.getSettingsValue('syntheticUserEmailDomains'));
  } catch {
    return [];
  }
}

/** Classify and persist a synthetic account without reading acquisition cookies from its creator. */
export async function recordSyntheticIdentity(user: {
  id: string;
  username?: string | null;
  email?: string | null;
}): Promise<boolean> {
  const isSynthetic = isSyntheticIdentity(user, await syntheticTestDomains());
  if (!isSynthetic) return false;
  try {
    await userRepository.update({ id: user.id, isSynthetic: true });
  } catch (err) {
    console.warn('[b4m-analytics] synthetic identity not persisted', err instanceof Error ? err.message : err);
  }
  return true;
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
  // Decided first and kept through a failed write: callers gate the signup pixel, the
  // cross-product credit and the synthetic lane on it, so a write error must not turn a persona
  // into a real signup.
  let isSynthetic = false;
  try {
    isSynthetic = isSyntheticIdentity(opts.user, await syntheticTestDomains());
    const acquisition = toUserAcquisition(readConsentedAcquisitionTouches(opts.req), opts.method);
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
    return { isSynthetic };
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

export type FunnelEvent = 'credits_granted' | 'email_verified' | 'first_value' | 'signup_completed';

/**
 * One once-per-user funnel stage to Overwatch under the host product. The eventId is keyed on the
 * user's pseudonym, so a retried handler sends the same id and the receiver keeps one event. The
 * campaign is the stored first touch, not the 30-minute session cookie, so later stages stay
 * joinable to the door the user came through. Never throws. Resolves to whether an emit was
 * attempted.
 *
 * A synthetic user's stages are sent with `lane: 'synthetic'` rather than skipped. Skipped, a
 * persona's signup was indistinguishable from no signup at all; marked, it can be counted apart
 * from real signups and a persona run can still be checked. The lane is spread last so caller
 * metadata cannot unmark a synthetic user.
 */
export async function emitFunnelEvent(opts: {
  user: FunnelUser;
  event: FunnelEvent;
  metadata?: Record<string, string | number | boolean>;
}): Promise<boolean> {
  const utm = opts.user.acquisition?.firstTouch;
  const metadata = { ...opts.metadata, ...laneMetadata(opts.user) };
  await emitProductEvent({
    productId: HOST_PRODUCT_ID,
    event: opts.event,
    eventId: stableEventId(opts.event, HOST_PRODUCT_ID, pseudonymizeUserId(opts.user.id)),
    userId: opts.user.id,
    ...(utm && { utm }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  }).catch(() => {});
  return true;
}

// A stage an admin caused (create-user, bulk-create-users, an admin verifying the email) is still
// the stage, but not a day its user was active: `userAction: false` keeps Overwatch from counting
// them in DAU, or as a new user, before they have signed in once; their first real request does
// that. Overwatch also leaves `userAction: false` signups out of the funnel's signup count, so an
// admin-created account does not inflate signups either.
function funnelMethodMetadata(method: string): { method: string; userAction?: false } {
  return { method, ...(method === 'admin' && { userAction: false as const }) };
}

/**
 * The funnel stages of a brand-new account. An unverified signup with nothing granted skips
 * credits_granted: the stable eventId would lock in 0 and drop the grant that arrives at
 * verification (emitEmailVerifiedFunnelEvents). An unverified signup granted credits immediately
 * owns that stable stage, so later verification grants are not separately represented. The emits
 * are independent, so they run concurrently to bound the caller's latency at one emit timeout.
 */
export async function emitSignupFunnelEvents(opts: {
  user: FunnelUser;
  method: string;
  emailVerified: boolean;
  creditsGranted: number;
}): Promise<void> {
  const metadata = funnelMethodMetadata(opts.method);
  await Promise.all([
    opts.emailVerified && emitFunnelEvent({ user: opts.user, event: 'email_verified', metadata }),
    (opts.emailVerified || opts.creditsGranted > 0) &&
      emitFunnelEvent({
        user: opts.user,
        event: 'credits_granted',
        metadata: { amount: opts.creditsGranted, source: 'signup', ...metadata },
      }),
    emitFunnelEvent({ user: opts.user, event: 'signup_completed', metadata }),
  ]);
}

/**
 * The funnel stages of an existing account becoming email-verified. Gated to accounts created
 * after launch: no backfill of earlier accounts, the same rule as first_value.
 */
export async function emitEmailVerifiedFunnelEvents(opts: {
  user: FunnelUser & { createdAt?: Date | string | null };
  method: string;
  creditsGranted: number;
}): Promise<void> {
  if (!signedUpAfterLaunch(opts.user.createdAt)) return;
  const metadata = funnelMethodMetadata(opts.method);
  await Promise.all([
    emitFunnelEvent({ user: opts.user, event: 'email_verified', metadata }),
    emitFunnelEvent({
      user: opts.user,
      event: 'credits_granted',
      metadata: { amount: opts.creditsGranted, source: 'signup', ...metadata },
    }),
    rewardInviterForFirstAnswer(opts.user.id),
  ]);
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
  onRecorded?: () => Promise<void>;
}): Promise<boolean> {
  if (!signedUpAfterLaunch(opts.user.createdAt)) return false;
  try {
    const now = opts.now ?? new Date();
    const res = await User.updateOne({ _id: opts.user.id, firstValueAt: null }, { $set: { firstValueAt: now } });
    if (res.modifiedCount !== 1) return false;
    await opts.onRecorded?.();
    const createdAt = opts.user.createdAt ? new Date(opts.user.createdAt).getTime() : NaN;
    const [emitted] = await Promise.all([
      emitFunnelEvent({
        user: opts.user,
        event: 'first_value',
        metadata: {
          feature: opts.feature,
          ...(Number.isFinite(createdAt) && {
            secondsSinceSignup: Math.max(0, Math.round((now.getTime() - createdAt) / 1000)),
          }),
        },
      }),
      rewardInviterForFirstAnswer(opts.user.id),
    ]);
    return emitted;
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
  loadQuest: () => Promise<{ status?: string; type?: string; creditsUsed?: number } | null | undefined>;
}): Promise<boolean> {
  if (opts.user.firstValueAt || !signedUpAfterLaunch(opts.user.createdAt)) return false;
  const quest = await opts.loadQuest().catch(() => undefined);
  if (quest?.status !== 'done' || quest.type === 'error') return false;
  return recordFirstValue({
    user: opts.user,
    feature: 'chat',
    onRecorded: () =>
      logEventSafe({
        userId: opts.user.id,
        type: FirstRunEvents.FIRST_ANSWER_CREDITS,
        metadata: { credits: quest.creditsUsed ?? 0 },
      }),
  });
}
