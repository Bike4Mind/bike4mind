import { adminSettingsRepository } from '@bike4mind/database';
import { type IAdminSettings, resolveSignupGrantSettings, settingsMap } from '@bike4mind/common';

const STARTER_CREDIT_SETTINGS: IAdminSettings['settingName'][] = [
  'allowOpenRegistration',
  'defaultFreeCredits',
  'stagedSignupGrantEnabled',
  'signupGrantCredits',
];

/**
 * Credits an open sign-up starts with, for user-facing copy (the share-page sign-up gate).
 * Mirrors the grant in userService.register / api/email/verify: the staged signup tranche when
 * staged grants are on, else `defaultFreeCredits`, and only when `allowOpenRegistration` is on -
 * an invite-only deployment grants nothing to a stranger, so advertising a number there would
 * be false. Returns 0 (render no number) on any failure.
 */
export async function getOpenSignupStarterCredits(): Promise<number> {
  try {
    // One round trip: this runs on every anonymous view of an open-public page.
    const rows = await adminSettingsRepository.findBySettingNames(STARTER_CREDIT_SETTINGS);
    const byName = (name: IAdminSettings['settingName']) => rows.find(r => r.settingName === name) ?? null;
    const open = settingsMap.allowOpenRegistration.schema.safeParse(byName('allowOpenRegistration')?.settingValue);
    if (!(open.success ? open.data : settingsMap.allowOpenRegistration.defaultValue)) return 0;
    const staged = await resolveSignupGrantSettings({ findBySettingName: async name => byName(name) });
    if (staged.enabled) return staged.signupCredits;
    const amount = settingsMap.defaultFreeCredits.schema.safeParse(byName('defaultFreeCredits')?.settingValue);
    return amount.success ? amount.data : 0;
  } catch {
    return 0;
  }
}
