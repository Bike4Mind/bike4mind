import { adminSettingsRepository } from '@bike4mind/database';
import { settingsMap } from '@bike4mind/common';

/**
 * Credits an open sign-up starts with, for user-facing copy (the share-page sign-up gate).
 * Mirrors the grant in userService.register / api/email/verify: `defaultFreeCredits`, and only
 * when `allowOpenRegistration` is on - an invite-only deployment grants nothing to a stranger,
 * so advertising a number there would be false. Returns 0 (render no number) on any failure.
 */
export async function getOpenSignupStarterCredits(): Promise<number> {
  try {
    // One round trip: this runs on every anonymous view of an open-public page.
    const rows = await adminSettingsRepository.findBySettingNames(['allowOpenRegistration', 'defaultFreeCredits']);
    const openReg = rows.find(r => r.settingName === 'allowOpenRegistration');
    const freeCredits = rows.find(r => r.settingName === 'defaultFreeCredits');
    const open = settingsMap.allowOpenRegistration.schema.safeParse(openReg?.settingValue);
    if (!(open.success ? open.data : settingsMap.allowOpenRegistration.defaultValue)) return 0;
    const amount = settingsMap.defaultFreeCredits.schema.safeParse(freeCredits?.settingValue);
    return amount.success ? amount.data : 0;
  } catch {
    return 0;
  }
}
