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
  'credit_purchase',
] as const;

export type SignupGrantUnlockReason = (typeof SIGNUP_GRANT_UNLOCK_REASONS)[number];

/** Unlocks bought with a payment, which a stolen card can fake until the payment settles. */
export const PAYMENT_UNLOCK_REASONS = ['card_verified', 'subscription', 'credit_purchase'] as const;
export type PaymentUnlockReason = (typeof PAYMENT_UNLOCK_REASONS)[number];

export const isPaymentUnlockReason = (reason: unknown): reason is PaymentUnlockReason =>
  (PAYMENT_UNLOCK_REASONS as readonly unknown[]).includes(reason);

/** Payment events that cancel a held payment unlock and close every non-admin signup release for the account. */
export const SIGNUP_UNLOCK_FORFEIT_CAUSES = ['dispute', 'refund', 'fraud_warning'] as const;
export type SignupUnlockForfeitCause = (typeof SIGNUP_UNLOCK_FORFEIT_CAUSES)[number];

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
  /** Organization whose invite released the remainder (historical; no longer enforced). */
  unlockedOrgId?: string;
  /** Credits released by the activity drip so far; absent on grants that predate it. */
  dripCredits?: number;
  /** UTC day (YYYY-MM-DD) of the latest drip payout. */
  lastDripDay?: string;
  /** Preview testing window of the latest payout; UTC budget accounting still uses lastDripDay. */
  lastDripPeriod?: string;
  /** Active-session time accrued on one UTC day, advanced by the server from heartbeat pings. */
  activity?: { day: string; ms: number; lastAt: Date; period?: string };
  /** A payment unlock waiting for its payment to settle; the held-release job pays it from `releaseAt`. */
  heldUnlock?: { reason: PaymentUnlockReason; heldAt: Date; releaseAt: Date };
  /** A disputed, refunded or fraud-warned payment: only an admin can release more of the grant. */
  unlockForfeited?: { cause: SignupUnlockForfeitCause; at: Date };
  /**
   * Invite bonus paid on top of the grant (payInviteBonus). Never counted in creditsReleased, so the
   * unlock remainder and the drip cap are computed as if no bonus were paid.
   */
  inviteBonusPaid?: number;
  /**
   * An admin stopped every grant and reward for this account; nothing already granted is taken back.
   * Only the time lives here: the reason and the acting admin are in the audit entry. redactUserSecretsForSelf
   * (REST) and the users websocket field limits remove this field from every user-facing copy, admin views of
   * another user included, so admin tooling reads block state from its own admin endpoint.
   */
  blocked?: { at: Date };
}

/** Whether an admin has stopped grants and rewards for this account (see SignupGrant.blocked). */
export const isSignupGrantBlocked = (user: { signupGrant?: Pick<SignupGrant, 'blocked'> | null }): boolean =>
  !!user.signupGrant?.blocked;

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

/** Pass the live `dripCap` wherever an unlock pays, so the remainder matches what the unlock releases. */
export function signupGrantRemaining(grant: SignupGrant, dripCap?: number): number {
  const unlockCredits = dripCap === undefined ? grant.unlockCredits : signupGrantUnlockCredits(grant, dripCap);
  return Math.max(0, grant.signupCredits + unlockCredits - grant.creditsReleased);
}

/**
 * The locked pool a full unlock releases up to. While the drip is still open the live cap governs it,
 * so an unlock after a cap raise pays the raised headroom; a grant a verification unlock closed keeps it.
 */
export function signupGrantUnlockCredits(grant: SignupGrant, dripCap: number): number {
  return signupGrantDripOpen(grant) ? Math.max(grant.unlockCredits, dripCap) : grant.unlockCredits;
}

/** Credits the drip may still pay under `dripCap`; never negative when the cap was lowered below what was dripped. */
export function signupGrantDripRemaining(grant: Pick<SignupGrant, 'dripCredits'>, dripCap: number): number {
  const dripped = grant.dripCredits ?? 0;
  return Math.max(0, dripCap - (Number.isSafeInteger(dripped) && dripped > 0 ? dripped : 0));
}

export function nonnegativeGrantCredits(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  if (typeof value === 'string' && !value.trim()) return 0;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

export type SignupGrantCreditKey =
  'signupGrantInitialCredits' | 'signupGrantDailyCredits' | 'signupGrantDripCap' | 'signupGrantInviteBonusCredits';

/** A stored credit amount, or undefined when absent, blank or invalid so the caller falls back; '0' is a value. */
export function storedGrantCredits(key: SignupGrantCreditKey, value: unknown): number | undefined {
  if (value == null || (typeof value === 'string' && !value.trim())) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!settingsMap[key].schema.safeParse(value).success) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

/** 'default' means signupGrantDripCap is unset and its registry default applies. */
export type SignupGrantDripCapSource = 'setting' | 'default';

export interface SignupGrantSchedule {
  initialCredits: number;
  dailyCredits: number;
  dripCap: number;
  /** Locked at enrollment and released by a verification unlock. */
  unlockCredits: number;
  /** Nothing is locked, so a referral invite pays whole as the pre-staging flat grant did. */
  paysFlat: boolean;
  inviteBonusCredits: number;
  dripCapSource: SignupGrantDripCapSource;
}

/** The drip may still pay: the grant is mid-drip, or a drip completed it and a raised cap can reopen it. A forfeited grant never pays. */
export function signupGrantDripOpen(grant: Pick<SignupGrant, 'stage' | 'unlockedBy' | 'unlockForfeited'>): boolean {
  if (grant.unlockForfeited) return false;
  return grant.stage === 'signup' || (grant.stage === 'unlocked' && grant.unlockedBy === 'activity_drip');
}

/**
 * The schedule from the four schedule keys. Shared by resolveSignupGrantSchedule and the client mirror
 * (useSignupGrantSchedule.ts) so both read the same keys.
 */
export function runtimeSignupGrantSchedule(
  read: (key: SignupGrantCreditKey) => number | undefined
): SignupGrantSchedule {
  const cap = read('signupGrantDripCap');
  const dripCap = cap ?? settingsMap.signupGrantDripCap.defaultValue ?? 0;
  return {
    initialCredits: read('signupGrantInitialCredits') ?? 0,
    dailyCredits: read('signupGrantDailyCredits') ?? 0,
    dripCap,
    unlockCredits: dripCap,
    paysFlat: dripCap === 0,
    inviteBonusCredits: read('signupGrantInviteBonusCredits') ?? 0,
    dripCapSource: cap === undefined ? 'default' : 'setting',
  };
}

const SCHEDULE_KEYS: SignupGrantCreditKey[] = [
  'signupGrantInitialCredits',
  'signupGrantDailyCredits',
  'signupGrantDripCap',
  'signupGrantInviteBonusCredits',
];

type ScheduleSettingsReader = Pick<IAdminSettingsRepository, 'findBySettingName'> &
  Partial<Pick<IAdminSettingsRepository, 'findBySettingNames'>>;

/** One batched read when available. */
export async function resolveSignupGrantSchedule(adminSettings: ScheduleSettingsReader): Promise<SignupGrantSchedule> {
  const values = new Map<string, unknown>();
  if (adminSettings.findBySettingNames) {
    for (const row of await adminSettings.findBySettingNames(SCHEDULE_KEYS)) {
      values.set(row.settingName, row.settingValue);
    }
  } else {
    for (const key of SCHEDULE_KEYS) {
      values.set(key, (await adminSettings.findBySettingName(key))?.settingValue);
    }
  }
  return runtimeSignupGrantSchedule(key => storedGrantCredits(key, values.get(key)));
}

export async function resolveSignupGrantSettings(adminSettings: ScheduleSettingsReader) {
  const schedule = await resolveSignupGrantSchedule(adminSettings);
  return { signupCredits: schedule.initialCredits, unlockCredits: schedule.unlockCredits };
}

/**
 * Every signup enrolls a staged grant. A drip cap of 0 (seeded where staging used to be off) locks nothing,
 * so the grant pays the flat path's amount; unlike the flat path, an invite-resolved amount now takes the
 * canonical-inbox claim and the risk policy on payout, as a staged referral grant always did.
 * `totalCredits` sets the enrolled entitlement (tranche first, remainder locked) instead of the signup settings.
 * It is a floor, not a ceiling: the drip and verification unlocks still grow the pool to the live drip cap
 * (signupGrantUnlockCredits, the drip branch in stagedSignupGrant.ts), so an invitee gets the larger of
 * `totalCredits` and the open-signup schedule. signupGrantInviteBonusCredits is the on-top invite bonus
 * (payInviteBonus).
 */
export async function newSignupGrant(adminSettings: ScheduleSettingsReader, totalCredits?: number) {
  const schedule = await resolveSignupGrantSchedule(adminSettings);
  const signupCredits =
    totalCredits === undefined
      ? schedule.initialCredits
      : schedule.paysFlat
        ? totalCredits
        : Math.min(schedule.initialCredits, totalCredits);
  return {
    stage: 'pending_email',
    signupCredits,
    unlockCredits: totalCredits === undefined ? schedule.unlockCredits : totalCredits - signupCredits,
    creditsReleased: 0,
    nextCondition: 'email_verification',
  } satisfies SignupGrant;
}
