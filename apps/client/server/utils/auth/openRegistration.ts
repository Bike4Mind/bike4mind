import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';

/**
 * The `allowOpenRegistration` master switch, resolved the same way everywhere.
 *
 * Shared so the pre-login config the register form reads
 * (pages/api/settings/serverConfigPublic.ts) and the server-side gates that actually
 * refuse account creation cannot disagree - a mismatch shows the user an open signup
 * form and then rejects them, or worse, the reverse.
 *
 * Parses through the canonical Zod schema so persisted booleans, "true"/"false"
 * strings and a missing record all resolve correctly; a raw `=== 'true'` would
 * silently miss the boolean form and leave the switch permanently off. Defaults to
 * false (invite-only), matching userService.registerUser.
 */
export async function isOpenRegistrationAllowed(): Promise<boolean> {
  const setting = await adminSettingsRepository.findBySettingName('allowOpenRegistration').catch(() => null);
  const parsed = settingsMap.allowOpenRegistration.schema.safeParse(setting?.settingValue);
  const allowOpenRegistration = parsed.success ? parsed.data : false;

  // Self-host bootstrap: a fresh install (no users yet) accepts its first registration
  // without an invite. Flips back off as soon as one user exists.
  if (!allowOpenRegistration && process.env.B4M_SELF_HOST === 'true') {
    return (await userRepository.count({})) === 0;
  }

  return allowOpenRegistration;
}
