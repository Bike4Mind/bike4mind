import type { IAdminSettingsRepository } from './types';

export const SIGNUP_GRANT_UNLOCK_REASONS = [
  'card_verified',
  'phone_verified',
  'admin',
  'activity',
  'org_invite',
  'github_verified',
  'work_email_verified',
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

/** A signup grant above this many credits may only be raised while the signup protections are on. */
export const LARGE_SIGNUP_GRANT_CREDITS = 100;

/** Each ships off or zero by default, so each only protects once an operator turns it on. */
export const SIGNUP_GRANT_PROTECTION_KEYS = [
  'signupGrantRiskPolicy',
  'maxSignupsPerIpPerDay',
  'maxSignupsPerAsnPerHour',
  'signupBurstAutoHold',
] as const;

export type SignupGrantProtectionKey = (typeof SIGNUP_GRANT_PROTECTION_KEYS)[number];

export const SIGNUP_GRANT_KEYS = ['defaultFreeCredits', 'signupGrantCredits', 'verifiedUnlockCredits'] as const;

export type SignupGrantKey = (typeof SIGNUP_GRANT_KEYS)[number];

const isOn = (value: unknown) => value === true || value === 'true';

/** The policy is stored as a JSON string by the seed migration and as an object elsewhere; the runtime reads both. */
function parsePolicyValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Protections still at their off defaults; stored settings may arrive as strings. */
export function findUnsetSignupProtections(
  values: Partial<Record<SignupGrantProtectionKey, unknown>>
): SignupGrantProtectionKey[] {
  const policy = parsePolicyValue(values.signupGrantRiskPolicy);
  // Boolean literal only: signupRiskPolicySchema rejects the string 'true', so that shape offers no protection.
  const policyOn = typeof policy === 'object' && policy !== null && (policy as { enabled?: unknown }).enabled === true;
  const checks: Record<SignupGrantProtectionKey, boolean> = {
    signupGrantRiskPolicy: policyOn,
    maxSignupsPerIpPerDay: nonnegativeGrantCredits(values.maxSignupsPerIpPerDay) > 0,
    maxSignupsPerAsnPerHour: nonnegativeGrantCredits(values.maxSignupsPerAsnPerHour) > 0,
    signupBurstAutoHold: isOn(values.signupBurstAutoHold),
  };
  return SIGNUP_GRANT_PROTECTION_KEYS.filter(key => !checks[key]);
}

/** Any finite positive amount counts, including the fractions and huge values defaultFreeCredits accepts. */
function configuredGrantAmount(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  if (typeof value === 'string' && !value.trim()) return 0;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** What one grant path pays: the flat grant, or the staged signup plus unlock total. */
export function signupGrantPathTotal(key: SignupGrantKey, values: Partial<Record<SignupGrantKey, unknown>>): number {
  if (key === 'defaultFreeCredits') return configuredGrantAmount(values.defaultFreeCredits);
  return configuredGrantAmount(values.signupGrantCredits) + configuredGrantAmount(values.verifiedUnlockCredits);
}

/** Largest grant a new account could receive across both grant paths. */
export function largestSignupGrant(values: Partial<Record<SignupGrantKey, unknown>>): number {
  return Math.max(
    signupGrantPathTotal('defaultFreeCredits', values),
    signupGrantPathTotal('signupGrantCredits', values)
  );
}

/** Matched verbatim by the log metric filter in infra/signupAlarms.ts; change both together. */
export const SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE = 'signup-grant-protections-off';

/** The exposed state: a grant above the limit is live while a protection is still off, else null. */
export function signupGrantProtectionGap(
  values: Partial<Record<SignupGrantKey | SignupGrantProtectionKey, unknown>>
): { largestGrant: number; unset: SignupGrantProtectionKey[] } | null {
  const largestGrant = largestSignupGrant(values);
  if (largestGrant <= LARGE_SIGNUP_GRANT_CREDITS) return null;
  const unset = findUnsetSignupProtections(values);
  return unset.length > 0 ? { largestGrant, unset } : null;
}

/**
 * True when a save would raise the largest grant above the large-grant limit. Lowering or keeping a
 * grant is never refused, so an operator can always walk an over-limit value back down.
 */
export function raisesGrantAboveLimit(before: number, after: number): boolean {
  return after > LARGE_SIGNUP_GRANT_CREDITS && after > before;
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

export async function newSignupGrant(adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>) {
  const enabled = await adminSettings.findBySettingName('stagedSignupGrantEnabled');
  if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return undefined;
  const config = await resolveSignupGrantSettings(adminSettings);
  return {
    stage: 'pending_email',
    signupCredits: config.signupCredits,
    unlockCredits: config.unlockCredits,
    creditsReleased: 0,
    nextCondition: 'email_verification',
  } satisfies SignupGrant;
}
