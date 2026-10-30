import {
  LARGE_SIGNUP_GRANT_CREDITS,
  SIGNUP_GRANT_GUARDED_KEYS,
  SIGNUP_GRANT_PROTECTION_KEYS,
  signupGrantWriteGap,
  type SignupGrantGuardedKey,
  type SignupGrantProtectionKey,
} from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';

export const isSignupGrantGuardedKey = (key: string): key is SignupGrantGuardedKey =>
  (SIGNUP_GRANT_GUARDED_KEYS as readonly string[]).includes(key);

/**
 * Protections still off when this write would leave a grant less protected (see signupGrantWriteGap), else null.
 * Two concurrent saves can both pass this uncoupled read; accepted here, and signupGrantProtectionAlarm catches it.
 */
export async function unsetProtectionsForSignupGrantWrite(
  key: SignupGrantGuardedKey,
  value: unknown
): Promise<SignupGrantProtectionKey[] | null> {
  const rows = await AdminSettings.find({ settingName: { $in: [...SIGNUP_GRANT_GUARDED_KEYS] } }).lean();
  const stored: Record<string, unknown> = Object.fromEntries(rows.map(row => [row.settingName, row.settingValue]));
  return signupGrantWriteGap(stored, { ...stored, [key]: value });
}

export const signupGrantRefusalMessage = (key: SignupGrantGuardedKey, unset: SignupGrantProtectionKey[]) =>
  (SIGNUP_GRANT_PROTECTION_KEYS as readonly string[]).includes(key)
    ? `Refusing to turn off ${key} while a signup grant above ${LARGE_SIGNUP_GRANT_CREDITS} credits is live. Lower the grant to ${LARGE_SIGNUP_GRANT_CREDITS} or less first.`
    : key === 'stagedSignupGrantEnabled'
      ? `Refusing to enable staged signup grants while the staged total is above ${LARGE_SIGNUP_GRANT_CREDITS} credits and these settings are still off: ${unset.join(', ')}. Turn them on first, then enable staging.`
      : `Refusing to raise the signup grant above ${LARGE_SIGNUP_GRANT_CREDITS} credits while these settings are still off: ${unset.join(', ')}. Turn them on first, then raise the grant.`;
