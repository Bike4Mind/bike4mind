import { adminSettingsRepository, User, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { isActivityDripEnabled, payActivityDripForDay, resolveRequiredActiveSeconds } from './activityUnlock';

// Client interval/idle constants live in app/hooks/useSignupGrantHeartbeat.ts; MAX_CREDIT_MS must exceed its interval.
const MIN_GAP_MS = 45_000;
const MAX_CREDIT_MS = 90_000;

interface HeartbeatResult {
  creditsGranted: number;
  paidToday: boolean;
  withheld: boolean;
  activeSeconds: number;
  requiredSeconds?: number;
}

/**
 * Accrues server-measured active time for a staged-grant account and pays the day's drip on the ping
 * that crosses the minimum. Pings closer than the minimum gap are no-ops with no write.
 */
export async function recordHeartbeat(userId: string, now: Date = new Date()): Promise<HeartbeatResult> {
  const result: HeartbeatResult = { creditsGranted: 0, paidToday: false, withheld: false, activeSeconds: 0 };
  const clock = signupProtection.grantBudget?.now?.() ?? now;
  const day = clock.toISOString().slice(0, 10);

  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  if (!grant || grant.stage !== 'signup') return result;
  if (grant.lastDripDay === day) return { ...result, paidToday: true };
  if (!(await isActivityDripEnabled())) return result;
  const requiredSeconds = await resolveRequiredActiveSeconds();
  result.requiredSeconds = requiredSeconds;
  const { dailyCredits, maxCredits } = await userService.resolveDripLimits(adminSettingsRepository);
  if (!(dailyCredits > 0) || !(maxCredits > 0) || (grant.dripCredits ?? 0) >= maxCredits) return result;

  const prior = grant.activity;
  const sameDay = prior?.day === day;
  const lastAt = prior ? new Date(prior.lastAt) : undefined;
  if (sameDay && lastAt && clock.getTime() - lastAt.getTime() < MIN_GAP_MS) {
    return { ...result, activeSeconds: Math.floor(prior.ms / 1000) };
  }

  const credited = sameDay && lastAt ? Math.min(Math.max(clock.getTime() - lastAt.getTime(), 0), MAX_CREDIT_MS) : 0;
  const ms = (sameDay ? prior.ms : 0) + credited;
  // Pinned to the observed lastAt so concurrent pings from several tabs credit one gap only.
  const written = await User.updateOne(
    {
      _id: userId,
      'signupGrant.stage': 'signup',
      ...(lastAt ? { 'signupGrant.activity.lastAt': lastAt } : { 'signupGrant.activity': { $exists: false } }),
    },
    { $set: { 'signupGrant.activity': { day, ms, lastAt: clock } } }
  );
  if (written.modifiedCount !== 1) return { ...result, activeSeconds: Math.floor((sameDay ? prior.ms : 0) / 1000) };

  result.activeSeconds = Math.floor(ms / 1000);
  if (ms < requiredSeconds * 1000) return result;
  const drip = await payActivityDripForDay(userId, now);
  result.creditsGranted = drip.creditsGranted;
  result.paidToday = drip.creditsGranted > 0;
  result.withheld = !result.paidToday && !!(drip.withheld || drip.budgetExhausted);
  return result;
}
