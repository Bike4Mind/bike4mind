import { settingsMap } from './schemas/settings';
import type { IAdminSettingsRepository } from './types';

export const SIGNUP_GRANT_UNLOCK_REASONS = [
  'card_verified',
  'phone_verified',
  'admin',
  'activity',
  'org_invite',
  'github_verified',
  'work_email_verified',
  'activity_drip',
  'subscription',
] as const;

export type SignupGrantUnlockReason = (typeof SIGNUP_GRANT_UNLOCK_REASONS)[number];

export interface SignupGrantAssessment {
  band: 'full' | 'reduced' | 'review';
  credits: number;
  score: number | null;
  reasons: string[];
  missing: string[];
  policyVersion: string | null;
  status: 'evaluated' | 'disabled' | 'unavailable';
}

export interface SignupGrant {
  stage: 'pending_email' | 'signup' | 'unlocked';
  signupCredits: number;
  unlockCredits: number;
  creditsReleased: number;
  nextCondition: 'email_verification' | 'verification' | null;
  unlockedBy?: SignupGrantUnlockReason;
  /** Organization whose invite released the remainder; caps org_invite unlocks per org. */
  unlockedOrgId?: string;
  /** Credits released by the activity drip so far; absent on grants that predate it. */
  dripCredits?: number;
  /** UTC day (YYYY-MM-DD) of the latest drip payout. */
  lastDripDay?: string;
  /** Preview testing window of the latest payout; UTC budget accounting still uses lastDripDay. */
  lastDripPeriod?: string;
  /** Active-session time accrued on one UTC day, advanced by the server from heartbeat pings. */
  activity?: { day: string; ms: number; lastAt: Date; period?: string };
}

export function hasPaidSignupDrip(
  grant: Pick<SignupGrant, 'lastDripDay' | 'lastDripPeriod'>,
  day: string,
  period?: string
): boolean {
  return period ? grant.lastDripPeriod === period : grant.lastDripDay === day;
}

const DEFAULT_SIGNUP_ACTIVE_SECONDS = 60;

/** Zero, non-integer and out-of-range values fall back to the default rather than switching the drip off. */
export function signupActiveSeconds(value: unknown): number {
  const seconds = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isInteger(seconds) && seconds >= 60 && seconds <= 7200 ? seconds : DEFAULT_SIGNUP_ACTIVE_SECONDS;
}

export function signupGrantRemaining(grant: SignupGrant): number {
  return Math.max(0, grant.signupCredits + grant.unlockCredits - grant.creditsReleased);
}

/** Credits the drip may still pay under `dripCap`; never negative when the cap was lowered below what was dripped. */
export function signupGrantDripRemaining(grant: Pick<SignupGrant, 'dripCredits'>, dripCap: number): number {
  return Math.max(0, dripCap - (Number.isSafeInteger(grant.dripCredits) ? (grant.dripCredits as number) : 0));
}

export function nonnegativeGrantCredits(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  if (typeof value === 'string' && !value.trim()) return 0;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

export type SignupGrantCreditKey =
  | 'signupGrantInitialCredits'
  | 'signupGrantDailyCredits'
  | 'signupGrantDripCap'
  | 'signupGrantInviteBonusCredits'
  | 'signupGrantCredits'
  | 'defaultFreeCredits'
  | 'signupGrantActivityDailyCredits'
  | 'signupGrantActivityMaxCredits'
  | 'verifiedUnlockCredits';

/** A stored credit amount, or undefined when absent, blank or invalid so the caller falls back; '0' is a value. */
export function storedGrantCredits(key: SignupGrantCreditKey, value: unknown): number | undefined {
  if (value == null || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!settingsMap[key].schema.safeParse(value).success) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

export type SignupGrantDripCapSource = 'setting' | 'legacy' | 'default';

export interface SignupGrantSchedule {
  initialCredits: number;
  dailyCredits: number;
  dripCap: number;
  inviteBonusCredits: number;
  dripCapSource: SignupGrantDripCapSource;
}

/**
 * Resolves the schedule from stored values. Must stay in sync with the client mirror in
 * apps/client/app/hooks/useSignupGrantSchedule.ts.
 */
export function signupGrantScheduleFromValues(
  read: (key: SignupGrantCreditKey) => number | undefined
): SignupGrantSchedule {
  const cap = read('signupGrantDripCap');
  const legacyCaps = [read('signupGrantActivityMaxCredits'), read('verifiedUnlockCredits')].filter(
    (value): value is number => value !== undefined
  );
  return {
    initialCredits: read('signupGrantInitialCredits') ?? read('signupGrantCredits') ?? read('defaultFreeCredits') ?? 0,
    dailyCredits: read('signupGrantDailyCredits') ?? read('signupGrantActivityDailyCredits') ?? 0,
    dripCap: cap ?? (legacyCaps.length ? Math.min(...legacyCaps) : (settingsMap.signupGrantDripCap.defaultValue ?? 0)),
    inviteBonusCredits: read('signupGrantInviteBonusCredits') ?? 0,
    dripCapSource: cap !== undefined ? 'setting' : legacyCaps.length ? 'legacy' : 'default',
  };
}

const SCHEDULE_KEYS: SignupGrantCreditKey[] = [
  'signupGrantInitialCredits',
  'signupGrantDailyCredits',
  'signupGrantDripCap',
  'signupGrantInviteBonusCredits',
  'signupGrantCredits',
  'defaultFreeCredits',
  'signupGrantActivityDailyCredits',
  'signupGrantActivityMaxCredits',
  'verifiedUnlockCredits',
];

/** The new schedule keys win; while one is unset its pre-schedule key still applies. */
export async function resolveSignupGrantSchedule(
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>
): Promise<SignupGrantSchedule> {
  const stored = new Map<SignupGrantCreditKey, number | undefined>();
  for (const key of SCHEDULE_KEYS) {
    stored.set(key, storedGrantCredits(key, (await adminSettings.findBySettingName(key))?.settingValue));
  }
  return signupGrantScheduleFromValues(key => stored.get(key));
}

export async function resolveSignupGrantSettings(adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>) {
  const schedule = await resolveSignupGrantSchedule(adminSettings);
  return { signupCredits: schedule.initialCredits, unlockCredits: schedule.dripCap };
}

/**
 * Every signup enrolls a staged grant. A drip cap of 0 (seeded where staging used to be off) locks nothing,
 * so the grant pays the same initial credits the flat path did.
 * `totalCredits` fixes the whole entitlement (tranche first, remainder locked) instead of the signup settings.
 */
export async function newSignupGrant(
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>,
  totalCredits?: number
) {
  const config = await resolveSignupGrantSettings(adminSettings);
  const signupCredits =
    totalCredits === undefined ? config.signupCredits : Math.min(config.signupCredits, totalCredits);
  return {
    stage: 'pending_email',
    signupCredits,
    unlockCredits: totalCredits === undefined ? config.unlockCredits : totalCredits - signupCredits,
    creditsReleased: 0,
    nextCondition: 'email_verification',
  } satisfies SignupGrant;
}
