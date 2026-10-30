import { signupGrantRiskPolicySchema } from './signupRiskPolicy';
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

/** Every setting the large-grant check reads: the grants, the protections, and whether the staged path is live. */
export const SIGNUP_GRANT_GUARDED_KEYS = [
  ...SIGNUP_GRANT_KEYS,
  ...SIGNUP_GRANT_PROTECTION_KEYS,
  'stagedSignupGrantEnabled',
] as const;

export type SignupGrantGuardedKey = (typeof SIGNUP_GRANT_GUARDED_KEYS)[number];

type SignupGrantValues = Partial<Record<SignupGrantGuardedKey, unknown>>;

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
  // Same check the runtime applies: a policy that fails the schema is never assessed, so it offers no protection.
  const parsedPolicy = signupGrantRiskPolicySchema.safeParse(policy);
  const policyOn = parsedPolicy.success && parsedPolicy.data.enabled;
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

/**
 * What one grant path pays: the flat grant, or the staged signup plus unlock total. A missing signup row
 * falls back to the flat grant, as resolveSignupGrantSettings does.
 */
export function signupGrantPathTotal(key: SignupGrantKey, values: Partial<Record<SignupGrantKey, unknown>>): number {
  if (key === 'defaultFreeCredits') return configuredGrantAmount(values.defaultFreeCredits);
  const signup = values.signupGrantCredits === undefined ? values.defaultFreeCredits : values.signupGrantCredits;
  return configuredGrantAmount(signup) + configuredGrantAmount(values.verifiedUnlockCredits);
}

/** Largest grant a new account could receive; the staged path counts only while staging is enabled. */
export function largestSignupGrant(values: SignupGrantValues): number {
  const flat = signupGrantPathTotal('defaultFreeCredits', values);
  return isOn(values.stagedSignupGrantEnabled)
    ? Math.max(flat, signupGrantPathTotal('signupGrantCredits', values))
    : flat;
}

/** Matched verbatim by the log metric filter in infra/signupAlarms.ts; change both together. */
export const SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE = 'signup-grant-protections-off';

type SignupGrantPath = 'defaultFreeCredits' | 'signupGrantCredits';

const SIGNUP_GRANT_PATHS: readonly SignupGrantPath[] = ['defaultFreeCredits', 'signupGrantCredits'];

/** The risk policy only scores staged grants, so the flat path does not depend on it. */
function protectionsFor(path: SignupGrantPath): readonly SignupGrantProtectionKey[] {
  return path === 'defaultFreeCredits'
    ? SIGNUP_GRANT_PROTECTION_KEYS.filter(key => key !== 'signupGrantRiskPolicy')
    : SIGNUP_GRANT_PROTECTION_KEYS;
}

const isLivePath = (path: SignupGrantPath, values: SignupGrantValues) =>
  path === 'defaultFreeCredits' || isOn(values.stagedSignupGrantEnabled);

const stagedKeysChanged = (before: SignupGrantValues, after: SignupGrantValues) =>
  before.signupGrantCredits !== after.signupGrantCredits ||
  before.verifiedUnlockCredits !== after.verifiedUnlockCredits;

const inProtectionOrder = (keys: Set<SignupGrantProtectionKey>) =>
  SIGNUP_GRANT_PROTECTION_KEYS.filter(key => keys.has(key));

/** The exposed state: a live grant path above the limit while a protection it relies on is still off, else null. */
export function signupGrantProtectionGap(
  values: SignupGrantValues
): { largestGrant: number; unset: SignupGrantProtectionKey[] } | null {
  const unsetAll = findUnsetSignupProtections(values);
  const unset = new Set<SignupGrantProtectionKey>();
  for (const path of SIGNUP_GRANT_PATHS) {
    if (!isLivePath(path, values) || signupGrantPathTotal(path, values) <= LARGE_SIGNUP_GRANT_CREDITS) continue;
    for (const key of protectionsFor(path)) if (unsetAll.includes(key)) unset.add(key);
  }
  return unset.size > 0 ? { largestGrant: largestSignupGrant(values), unset: inProtectionOrder(unset) } : null;
}

/**
 * True when a save would raise the largest grant above the large-grant limit. Lowering or keeping a
 * grant is never refused, so an operator can always walk an over-limit value back down.
 */
export function raisesGrantAboveLimit(before: number, after: number): boolean {
  return after > LARGE_SIGNUP_GRANT_CREDITS && after > before;
}

/**
 * Protections still off when a save would leave a grant path above the limit less protected than before,
 * else null. Per path, refuses raising its total (a dormant staged total included, so enabling staging later
 * is never the first time it is checked), making it live over the limit (enabling staging), and turning off
 * a protection it relies on while it is live over the limit.
 */
export function signupGrantWriteGap(
  before: SignupGrantValues,
  after: SignupGrantValues
): SignupGrantProtectionKey[] | null {
  const unsetAfter = findUnsetSignupProtections(after);
  if (unsetAfter.length === 0) return null;
  const unsetBefore = findUnsetSignupProtections(before);
  const gap = new Set<SignupGrantProtectionKey>();
  for (const path of SIGNUP_GRANT_PATHS) {
    const missing = protectionsFor(path).filter(key => unsetAfter.includes(key));
    if (missing.length === 0) continue;
    const total = signupGrantPathTotal(path, after);
    // A dormant staged total that moved only through its flat-grant fallback is checked when staging is enabled.
    const raised =
      raisesGrantAboveLimit(signupGrantPathTotal(path, before), total) &&
      (isLivePath(path, after) || stagedKeysChanged(before, after));
    const exposed =
      isLivePath(path, after) &&
      total > LARGE_SIGNUP_GRANT_CREDITS &&
      (!isLivePath(path, before) || missing.some(key => !unsetBefore.includes(key)));
    if (raised || exposed) for (const key of missing) gap.add(key);
  }
  return gap.size > 0 ? inProtectionOrder(gap) : null;
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
