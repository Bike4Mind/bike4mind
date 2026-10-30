import { hasDeveloperUserTag } from '../schemas/user';
import type { ThrottleSource, ThrottleTier, UserRiskSignalType } from '../types/entities/UserTypes';

/** Admins and developer-tagged users are never throttled, whatever tier is stored. */
export function isThrottleExempt(user: { isAdmin?: boolean | null; tags?: readonly string[] | null }): boolean {
  return !!user.isAdmin || hasDeveloperUserTag(user.tags);
}

/** True when the user is in the restricted tier. Exempt users are never restricted in effect. */
export function isShadowTier(
  user:
    | {
        isAdmin?: boolean;
        tags?: string[] | null;
        throttle?: { tier?: ThrottleTier } | null;
      }
    | null
    | undefined
): boolean {
  if (!user || isThrottleExempt(user)) return false;
  return user.throttle?.tier === 'shadow';
}

const SOURCE_BY_SIGNAL: Record<UserRiskSignalType, ThrottleSource> = {
  signup_honeypot: 'signup_honeypot',
  signup_too_fast: 'signup_timing',
  signup_token_missing: 'signup_timing',
  signup_token_invalid: 'signup_timing',
  signup_token_expired: 'signup_timing',
};

export function throttleSourceForSignal(type: UserRiskSignalType): ThrottleSource {
  return SOURCE_BY_SIGNAL[type];
}
