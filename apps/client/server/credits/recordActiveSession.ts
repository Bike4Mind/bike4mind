import { hasPaidSignupDrip, signupGrantDripOpen, signupGrantDripRemaining } from '@bike4mind/common';
import { resolveSignupDripPeriod } from './signupDripPeriod';
import { adminSettingsRepository, User, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { isDripScheduleOn, payActivityDripForDay, resolveRequiredActiveSeconds } from './activityUnlock';

// Client interval/idle constants live in app/hooks/useSignupGrantHeartbeat.ts; MAX_CREDIT_MS must exceed its interval.
const MIN_GAP_MS = 45_000;
const MAX_CREDIT_MS = 90_000;

interface HeartbeatResult {
  creditsGranted: number;
  paidToday: boolean;
  withheld: boolean;
  activeSeconds: number;
  requiredSeconds?: number;
  nextEligibleAt?: number;
}

/**
 * Accrues server-measured active time for a staged-grant account and pays the earning window's drip on the ping
 * that crosses the minimum. Pings closer than the minimum gap are no-ops with no write.
 */
export async function recordHeartbeat(userId: string, now: Date = new Date()): Promise<HeartbeatResult> {
  const result: HeartbeatResult = { creditsGranted: 0, paidToday: false, withheld: false, activeSeconds: 0 };
  const clock = signupProtection.grantBudget?.now?.() ?? now;

  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  if (!grant || !signupGrantDripOpen(grant)) return result;
  const period = await resolveSignupDripPeriod(clock);
  const { day } = period;
  result.nextEligibleAt = period.endsAt;
  if (hasPaidSignupDrip(grant, day, period.key)) return { ...result, paidToday: true };
  if (!(await isDripScheduleOn())) return result;
  const requiredSeconds = await resolveRequiredActiveSeconds();
  result.requiredSeconds = requiredSeconds;
  const { dailyCredits, dripCap } = await userService.resolveDripLimits(adminSettingsRepository);
  if (!(dailyCredits > 0) || signupGrantDripRemaining(grant, dripCap) <= 0) return result;

  const prior = grant.activity;
  const samePeriod = prior?.day === day && prior.period === period.key;
  const lastAt = prior ? new Date(prior.lastAt) : undefined;
  if (samePeriod && lastAt && clock.getTime() - lastAt.getTime() < MIN_GAP_MS) {
    return { ...result, activeSeconds: Math.floor(prior.ms / 1000) };
  }

  const credited = samePeriod && lastAt ? Math.min(Math.max(clock.getTime() - lastAt.getTime(), 0), MAX_CREDIT_MS) : 0;
  const ms = (samePeriod ? prior.ms : 0) + credited;
  // Pinned to the observed lastAt so concurrent pings from several tabs credit one gap only.
  const written = await User.updateOne(
    {
      _id: userId,
      'signupGrant.stage': grant.stage,
      ...(lastAt ? { 'signupGrant.activity.lastAt': lastAt } : { 'signupGrant.activity': { $exists: false } }),
    },
    { $set: { 'signupGrant.activity': { day, ms, lastAt: clock, ...(period.key ? { period: period.key } : {}) } } }
  );
  if (written.modifiedCount !== 1) return { ...result, activeSeconds: Math.floor((samePeriod ? prior.ms : 0) / 1000) };

  result.activeSeconds = Math.floor(ms / 1000);
  if (ms < requiredSeconds * 1000) return result;
  const drip = await payActivityDripForDay(userId, clock, period);
  result.creditsGranted = drip.creditsGranted;
  result.paidToday = drip.creditsGranted > 0;
  result.withheld = !result.paidToday && !!(drip.withheld || drip.budgetExhausted);
  return result;
}
