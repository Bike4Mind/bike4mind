import { signupActiveSeconds, type IUserDocument } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

type DripResult = Awaited<ReturnType<typeof userService.dripSignupGrant>>;
const noGrant = (): DripResult => ({ creditsGranted: 0, currentCredits: null });

export async function isActivityDripEnabled(): Promise<boolean> {
  const enabled = await adminSettingsRepository.findBySettingName('signupGrantActivityEnabled');
  return enabled?.settingValue === 'true' || (enabled?.settingValue as unknown) === true;
}

export async function resolveRequiredActiveSeconds(): Promise<number> {
  return signupActiveSeconds(
    (await adminSettingsRepository.findBySettingName('signupGrantActivityMinActiveSeconds'))?.settingValue
  );
}

/** The server-accrued active time on the given UTC day reached the minimum. */
async function qualifiesOnDay(user: IUserDocument, day: string): Promise<boolean> {
  if (!(await isActivityDripEnabled())) return false;
  const activity = user.signupGrant?.activity;
  if (activity?.day !== day) return false;
  return activity.ms >= (await resolveRequiredActiveSeconds()) * 1000;
}

/**
 * Pays the activity drip for the UTC day of `now` unless the account is not eligible, already paid or capped.
 * Shared by the heartbeat and the eligibility route; the ledger id keeps a day to one payout.
 */
export async function payActivityDripForDay(userId: string, now: Date = new Date()) {
  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  if (!user || !grant || grant.stage === 'pending_email' || grant.stage === 'unlocked') return noGrant();
  // One clock for both the drip day and the budget draw, so they cannot straddle UTC midnight.
  const day = (signupProtection.grantBudget?.now?.() ?? now).toISOString().slice(0, 10);
  if (grant.lastDripDay === day) return noGrant();
  const { dailyCredits, maxCredits } = await userService.resolveDripLimits(adminSettingsRepository);
  if (!(dailyCredits > 0) || !(maxCredits > 0) || (grant.dripCredits ?? 0) >= maxCredits) return noGrant();
  return userService.dripSignupGrant(userId, day, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Kept the app open for the daily active time',
  });
}

/** Fallback for the eligibility route: pays when the accrued active time already qualifies the day. */
export async function unlockSignupGrantFromActivity(userId: string, now: Date = new Date()) {
  const user = await userRepository.findById(userId);
  if (!user?.signupGrant) return noGrant();
  const day = (signupProtection.grantBudget?.now?.() ?? now).toISOString().slice(0, 10);
  if (!(await qualifiesOnDay(user, day))) return noGrant();
  return payActivityDripForDay(userId, now);
}
