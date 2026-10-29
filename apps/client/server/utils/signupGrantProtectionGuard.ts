import {
  LARGE_SIGNUP_GRANT_CREDITS,
  SIGNUP_GRANT_KEYS,
  SIGNUP_GRANT_PROTECTION_KEYS,
  findUnsetSignupProtections,
  signupGrantPathTotal,
  raisesGrantAboveLimit,
  type SignupGrantKey,
  type SignupGrantProtectionKey,
} from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';

export const isSignupGrantKey = (key: string): key is SignupGrantKey =>
  (SIGNUP_GRANT_KEYS as readonly string[]).includes(key);

/**
 * Protections still at their off defaults when this write would raise the grant path it edits above
 * the limit, or null when the write is allowed. Reads the other grant fields and the protections from
 * storage, so a unit-by-unit increase cannot slip past by changing one field at a time.
 */
export async function unsetProtectionsForGrantIncrease(
  key: SignupGrantKey,
  value: unknown
): Promise<SignupGrantProtectionKey[] | null> {
  const names = [...SIGNUP_GRANT_KEYS, ...SIGNUP_GRANT_PROTECTION_KEYS];
  const rows = await AdminSettings.find({ settingName: { $in: names } }).lean();
  const stored: Record<string, unknown> = Object.fromEntries(rows.map(row => [row.settingName, row.settingValue]));

  const before = signupGrantPathTotal(key, stored);
  const after = signupGrantPathTotal(key, { ...stored, [key]: value });
  if (!raisesGrantAboveLimit(before, after)) return null;

  const unset = findUnsetSignupProtections(stored);
  return unset.length > 0 ? unset : null;
}

export const signupGrantRefusalMessage = (unset: SignupGrantProtectionKey[]) =>
  `Refusing to raise the signup grant above ${LARGE_SIGNUP_GRANT_CREDITS} credits while these settings are still off: ${unset.join(', ')}. Turn them on first, then raise the grant.`;
