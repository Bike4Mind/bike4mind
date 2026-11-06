import { z } from 'zod';

/**
 * Frozen copy of the pre-schedule signup grant resolver, kept for the migrations that translate the retired
 * settings into schedule keys. Runtime code must not import it; it stays put when the common resolver changes.
 */

export type LegacySignupGrantCreditKey =
  | 'signupGrantInitialCredits'
  | 'signupGrantDailyCredits'
  | 'signupGrantDripCap'
  | 'signupGrantInviteBonusCredits'
  | 'signupGrantCredits'
  | 'defaultFreeCredits'
  | 'signupGrantActivityDailyCredits'
  | 'signupGrantActivityMaxCredits'
  | 'verifiedUnlockCredits';

export interface LegacySignupGrantToggles {
  staged: boolean;
  activity: boolean;
}

export interface LegacySignupGrantSchedule {
  initialCredits: number;
  dailyCredits: number;
  dripCap: number;
  unlockCredits: number;
  paysFlat: boolean;
  inviteBonusCredits: number;
  dripCapSource: 'setting' | 'legacy' | 'default';
}

// Registry defaults at the time the keys were retired.
const VERIFIED_UNLOCK_DEFAULT = 0;
const ACTIVITY_MAX_DEFAULT = 9000;

const creditAmountSchema = z.coerce.number().int().min(0);

export const isStoredToggleOn = (value: unknown) => value === true || value === 'true';

/** A stored credit amount, or undefined when absent, blank or invalid so the caller falls back; '0' is a value. */
export function storedGrantCredits(_key: LegacySignupGrantCreditKey, value: unknown): number | undefined {
  if (value == null || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!creditAmountSchema.safeParse(value).success) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

export function signupGrantScheduleFromValues(
  read: (key: LegacySignupGrantCreditKey) => number | undefined,
  toggles: LegacySignupGrantToggles
): LegacySignupGrantSchedule {
  const cap = read('signupGrantDripCap');
  const verifiedUnlock = read('verifiedUnlockCredits') ?? VERIFIED_UNLOCK_DEFAULT;
  const activityMax = read('signupGrantActivityMaxCredits');
  const legacyCap = !toggles.staged ? 0 : Math.min(activityMax ?? ACTIVITY_MAX_DEFAULT, verifiedUnlock);
  const dripCap = cap ?? legacyCap;
  return {
    initialCredits:
      read('signupGrantInitialCredits') ??
      (toggles.staged ? read('signupGrantCredits') : undefined) ??
      read('defaultFreeCredits') ??
      0,
    dailyCredits:
      read('signupGrantDailyCredits') ?? (toggles.activity ? read('signupGrantActivityDailyCredits') : 0) ?? 0,
    dripCap,
    unlockCredits: cap !== undefined || !toggles.staged ? dripCap : verifiedUnlock,
    paysFlat: cap !== undefined ? cap === 0 : !toggles.staged,
    inviteBonusCredits: read('signupGrantInviteBonusCredits') ?? 0,
    dripCapSource: cap !== undefined ? 'setting' : toggles.staged && activityMax === undefined ? 'default' : 'legacy',
  };
}
