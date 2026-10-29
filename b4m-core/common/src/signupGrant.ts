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
  /** Active-session time accrued on one UTC day, advanced by the server from heartbeat pings. */
  activity?: { day: string; ms: number; lastAt: Date };
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

export function nonnegativeGrantCredits(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  if (typeof value === 'string' && !value.trim()) return 0;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

/** Missing new settings preserve the installed grant; migration never enables staging. */
export async function resolveSignupGrantSettings(adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>) {
  const enabled = await adminSettings.findBySettingName('stagedSignupGrantEnabled');
  const signup = await adminSettings.findBySettingName('signupGrantCredits');
  const legacy = signup == null ? await adminSettings.findBySettingName('defaultFreeCredits') : null;
  const unlock = await adminSettings.findBySettingName('verifiedUnlockCredits');
  return {
    enabled: enabled?.settingValue === 'true' || (enabled?.settingValue as unknown) === true,
    signupCredits: nonnegativeGrantCredits(signup == null ? legacy?.settingValue : signup.settingValue),
    unlockCredits: nonnegativeGrantCredits(unlock?.settingValue),
  };
}

/** `totalCredits` fixes the whole entitlement (tranche first, remainder locked) instead of the signup settings. */
export async function newSignupGrant(
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>,
  totalCredits?: number
) {
  const enabled = await adminSettings.findBySettingName('stagedSignupGrantEnabled');
  if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return undefined;
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
