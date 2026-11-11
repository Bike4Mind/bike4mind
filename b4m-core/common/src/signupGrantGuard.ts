import { settingsMap } from './schemas/settings';
import { storedGrantCredits } from './signupGrant';
import { signupRiskPolicySchema } from './signupRiskPolicy';

/**
 * Grants the signup assessment policy screens. The initial tranche is what the policy assesses; the invite
 * bonus is paid only once that tranche is paid in full, so a held tranche holds it too. The drip and the
 * verification unlock are not assessed by the policy (activity and verification gate them, and the trickle
 * pool caps them per day), so requiring the policy would not protect them and they are not guarded here.
 */
export const SIGNUP_GRANT_GUARDED_CREDIT_KEYS = ['signupGrantInitialCredits', 'signupGrantInviteBonusCredits'] as const;

export type SignupGrantGuardedCreditKey = (typeof SIGNUP_GRANT_GUARDED_CREDIT_KEYS)[number];

const isGuardedCreditKey = (key: string): key is SignupGrantGuardedCreditKey =>
  (SIGNUP_GRANT_GUARDED_CREDIT_KEYS as readonly string[]).includes(key);

/** Keys whose save checkSignupGrantSave can refuse. */
export const isSignupGrantGuardedSaveKey = (key: string): boolean =>
  key === 'signupGrantRiskPolicy' || isGuardedCreditKey(key);

/** Stored settings the guard reads; raw stored values (strings, JSON strings) are accepted. */
export const SIGNUP_GRANT_GUARD_SETTING_KEYS = [
  ...SIGNUP_GRANT_GUARDED_CREDIT_KEYS,
  'signupGrantRiskPolicy',
  'signupGrantUnprotectedMaxCredits',
] as const;

export type SignupGrantGuardSettings = Partial<Record<(typeof SIGNUP_GRANT_GUARD_SETTING_KEYS)[number], unknown>>;

export type SignupGrantGuardResult = { ok: true } | { ok: false; reason: string };

const OK: SignupGrantGuardResult = { ok: true };

const parseStoredJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const DEFAULT_UNPROTECTED_LIMIT = settingsMap.signupGrantUnprotectedMaxCredits.defaultValue ?? 0;

/** The stored limit, or the registry default when it is unset or unreadable. */
export function unprotectedSignupGrantLimit(stored: unknown): number {
  const parsed = settingsMap.signupGrantUnprotectedMaxCredits.schema.safeParse(stored ?? undefined);
  const value = parsed.success ? Number(parsed.data) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_UNPROTECTED_LIMIT;
}

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

/**
 * Save-time check that keeps a signup grant above signupGrantUnprotectedMaxCredits from being paid while
 * signupGrantRiskPolicy is off. `current` holds the other stored settings; the proposed value replaces the
 * stored one for `key`. Also refuses a signupGrantRiskPolicy the payout could not read, which would hold
 * every new signup grant. Lowering a grant is always allowed, so a configuration that is already out of
 * bounds can be brought back within them one key at a time.
 */
export function checkSignupGrantSave(
  key: string,
  value: unknown,
  current: SignupGrantGuardSettings
): SignupGrantGuardResult {
  if (key === 'signupGrantRiskPolicy') {
    const policy = signupRiskPolicySchema.safeParse(parseStoredJson(value));
    if (!policy.success) {
      const issues = policy.error.issues.map(issue =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
      );
      return { ok: false, reason: `Signup Grant Assessment Policy is not valid. ${issues.join('; ')}.` };
    }
    if (policy.data.enabled) return OK;
    const limit = unprotectedSignupGrantLimit(current.signupGrantUnprotectedMaxCredits);
    const above = SIGNUP_GRANT_GUARDED_CREDIT_KEYS.flatMap(creditKey => {
      const credits = storedGrantCredits(creditKey, current[creditKey]);
      return credits !== undefined && credits > limit
        ? [`${settingsMap[creditKey].name} is ${formatCredits(credits)}`]
        : [];
    });
    if (above.length === 0) return OK;
    return {
      ok: false,
      reason: `Signup Grant Assessment Policy can't be turned off while ${above.join(' and ')}, above the ${formatCredits(limit)} credit Unprotected Signup Grant Limit. Lower the grant first.`,
    };
  }

  if (!isGuardedCreditKey(key)) return OK;
  const credits = storedGrantCredits(key, value);
  const limit = unprotectedSignupGrantLimit(current.signupGrantUnprotectedMaxCredits);
  if (credits === undefined || credits <= limit) return OK;
  const policy = signupRiskPolicySchema.safeParse(parseStoredJson(current.signupGrantRiskPolicy));
  if (policy.success && policy.data.enabled) return OK;
  return {
    ok: false,
    reason: `${settingsMap[key].name} above ${formatCredits(limit)} credits needs a valid, enabled Signup Grant Assessment Policy. Enable the policy first, or keep the grant at ${formatCredits(limit)} or less.`,
  };
}
