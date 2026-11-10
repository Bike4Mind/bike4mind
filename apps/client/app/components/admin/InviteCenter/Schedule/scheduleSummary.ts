import { settingsMap } from '@bike4mind/common';
import { SCHEDULE_KEYS } from '../../settingHomes';

type ScheduleKey = (typeof SCHEDULE_KEYS)[number];

/** Each schedule key's saved value as its schema reads it (unset becomes the default), or null when the row is invalid. */
export type ScheduleValues = Record<ScheduleKey, number | null>;

/**
 * Whether invite sending is capped per sender. The send-limits work replaces this constant with a
 * server signal; until then the invite-bonus warning shows whenever a bonus is set.
 */
export const INVITE_SEND_LIMITS_LIVE = false;

export function readScheduleValues(storedByKey: ReadonlyMap<string, unknown>): ScheduleValues {
  return Object.fromEntries(
    SCHEDULE_KEYS.map(key => {
      const parsed = settingsMap[key].schema.safeParse(storedByKey.get(key));
      return [key, parsed.success && Number.isFinite(parsed.data) ? (parsed.data as number) : null];
    })
  ) as ScheduleValues;
}

const credits = (amount: number) => `${amount.toLocaleString('en-US')} credits`;
const positive = (value: number | null): value is number => value !== null && value > 0;

/** One-line description of what a new account receives under the saved schedule. */
export function describeNewAccountGrant(v: ScheduleValues): string {
  const initial = v.signupGrantInitialCredits ?? 0;
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
    summary += ' Paused: the trickle pool has no daily budget, so the drip and rewards are held.';
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
