import {
  isBlankSettingValue,
  runtimeSignupGrantSchedule,
  settingsMap,
  storedGrantCredits,
  type SignupGrantCreditKey,
} from '@bike4mind/common';
import { SIGNUP_SCHEDULE_KEYS } from '../../settingHomes';

type ScheduleKey = (typeof SIGNUP_SCHEDULE_KEYS)[number];

/** Each schedule key's saved value as the server resolves it. */
export type ScheduleValues = Record<ScheduleKey, number>;

/**
 * Whether invite sending is capped per sender. The send-limits work replaces this constant with a
 * server signal; until then the invite-bonus warning shows whenever a bonus is set.
 */
export const INVITE_SEND_LIMITS_LIVE = false;

/** Mirrors resolvePoolBudget in b4m-core/services/src/userService/signupGrantBudget.ts: blank or invalid pauses. */
function poolBudget(key: 'signupGrantSignupPoolDaily' | 'signupGrantTricklePoolDaily', raw: unknown): number {
  if (isBlankSettingValue(raw)) return 0;
  const parsed = settingsMap[key].schema.safeParse(raw);
  return parsed.success ? parsed.data : 0;
}

export function readScheduleValues(storedByKey: ReadonlyMap<string, unknown>): ScheduleValues {
  const schedule = runtimeSignupGrantSchedule((key: SignupGrantCreditKey) =>
    storedGrantCredits(key, storedByKey.get(key))
  );
  return {
    signupGrantInitialCredits: schedule.initialCredits,
    signupGrantDailyCredits: schedule.dailyCredits,
    signupGrantDripCap: schedule.dripCap,
    signupGrantInviteBonusCredits: schedule.inviteBonusCredits,
    signupGrantSignupPoolDaily: poolBudget('signupGrantSignupPoolDaily', storedByKey.get('signupGrantSignupPoolDaily')),
    signupGrantTricklePoolDaily: poolBudget(
      'signupGrantTricklePoolDaily',
      storedByKey.get('signupGrantTricklePoolDaily')
    ),
  };
}

const credits = (amount: number) => `${amount.toLocaleString('en-US')} credits`;
const positive = (value: number) => value > 0;

/** One-line description of what a new account receives under the saved schedule. */
export function describeNewAccountGrant(v: ScheduleValues): string {
  const initial = v.signupGrantInitialCredits;
  const daily = v.signupGrantDailyCredits;
  const dripCap = v.signupGrantDripCap;
  const bonus = v.signupGrantInviteBonusCredits;

  // An unset or 0 drip cap means nothing drips, whatever the daily amount.
  const drips = positive(daily) && positive(dripCap);
  let summary = `New accounts get ${credits(initial)} after verification`;
  summary += drips ? `, then ${credits(daily)} per active day up to ${credits(dripCap)}.` : ', with no daily drip.';
  if (positive(bonus)) summary += ` Invited accounts get ${credits(bonus)} more.`;
  if (!positive(v.signupGrantSignupPoolDaily)) {
    summary += ' Paused: the signup pool has no daily budget, so initial grants and invite bonuses are held.';
  }
  if (!positive(v.signupGrantTricklePoolDaily)) {
    summary += drips
      ? ' Paused: the trickle pool has no daily budget, so daily activity grants are skipped and rewards are held.'
      : ' Paused: the trickle pool has no daily budget, so rewards are held.';
  }
  return summary;
}

/** True when a drip is configured but its total cap is below a single day's amount. */
export function dripCapWarning(v: ScheduleValues): boolean {
  const daily = v.signupGrantDailyCredits;
  const dripCap = v.signupGrantDripCap;
  return positive(daily) && positive(dripCap) && dripCap < daily;
}

export function inviteBonusWarning(v: ScheduleValues, sendLimitsLive: boolean): boolean {
  return positive(v.signupGrantInviteBonusCredits) && !sendLimitsLive;
}
