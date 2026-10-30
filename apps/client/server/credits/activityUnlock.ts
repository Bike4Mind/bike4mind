import {
  hasPaidSignupDrip,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  signupActiveSeconds,
  type IUserDocument,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { resolveSignupDripPeriod, type SignupDripPeriod } from './signupDripPeriod';

type DripResult = Awaited<ReturnType<typeof userService.dripSignupGrant>>;
const noGrant = (): DripResult => ({ creditsGranted: 0, currentCredits: null });

/** The drip runs whenever the schedule pays a positive daily amount; there is no separate on/off toggle. */
export async function isDripScheduleOn(): Promise<boolean> {
  return (await userService.resolveDripLimits(adminSettingsRepository)).dailyCredits > 0;
}

export async function resolveRequiredActiveSeconds(): Promise<number> {
  return signupActiveSeconds(
    (await adminSettingsRepository.findBySettingName('signupGrantActivityMinActiveSeconds'))?.settingValue
  );
}

/** The server-accrued active time in this earning window reached the minimum. */
async function qualifiesForPeriod(user: IUserDocument, period: SignupDripPeriod): Promise<boolean> {
  if (!(await isDripScheduleOn())) return false;
  const activity = user.signupGrant?.activity;
  if (activity?.day !== period.day || activity.period !== period.key) return false;
  return activity.ms >= (await resolveRequiredActiveSeconds()) * 1000;
}

/**
 * Pays the activity drip for the earning window of `now` unless the account is ineligible, already paid or capped.
 * Called by the heartbeat and, via unlockSignupGrantFromActivity, the eligibility route; the ledger id keeps each window to one payout.
 */
export async function payActivityDripForDay(userId: string, now: Date = new Date(), resolvedPeriod?: SignupDripPeriod) {
  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  if (!user || !grant || !signupGrantDripOpen(grant)) return noGrant();
  const period = resolvedPeriod ?? (await resolveSignupDripPeriod(signupProtection.grantBudget?.now?.() ?? now));
  if (hasPaidSignupDrip(grant, period.day, period.key)) return noGrant();
  const { dailyCredits, dripCap } = await userService.resolveDripLimits(adminSettingsRepository);
  if (!(dailyCredits > 0) || signupGrantDripRemaining(grant, dripCap) <= 0) return noGrant();
  return userService.dripSignupGrant(
    userId,
    period.day,
    {
      db: {
        users: userRepository,
        signupProtection,
        adminSettings: adminSettingsRepository,
        creditTransactions: creditTransactionRepository,
        creditLots: creditLotRepository,
      },
      reason: 'Kept the app open for the daily active time',
    },
    period.key
  );
}

/** Fallback for the eligibility route: pays when the accrued active time already qualifies the day. */
export async function unlockSignupGrantFromActivity(userId: string, now: Date = new Date()) {
  const user = await userRepository.findById(userId);
  if (!user?.signupGrant) return noGrant();
  const period = await resolveSignupDripPeriod(signupProtection.grantBudget?.now?.() ?? now);
  if (!(await qualifiesForPeriod(user, period))) return noGrant();
  return payActivityDripForDay(userId, now, period);
}
