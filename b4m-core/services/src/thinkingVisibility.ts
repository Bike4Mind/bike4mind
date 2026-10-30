import {
  IAdminSettingsRepository,
  isThinkingVisibility,
  settingsMap,
  type ThinkingVisibility,
} from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { hasPaidStanding, type PaidStandingSubject } from './userApiKeyService/trust';

export type ThinkingVisibilitySettings = { free: ThinkingVisibility; paid: ThinkingVisibility };

export const loadThinkingVisibilitySettings = async (db: {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
}): Promise<ThinkingVisibilitySettings> => {
  const settings = await getSettingsMap(db, { names: ['thinkingVisibilityFree', 'thinkingVisibilityPaid'] });
  const read = (key: 'thinkingVisibilityFree' | 'thinkingVisibilityPaid'): ThinkingVisibility => {
    const fallback = settingsMap[key].defaultValue as ThinkingVisibility;
    const value = getSettingsValue(key, settings, fallback);
    return isThinkingVisibility(value) ? value : fallback;
  };
  return { free: read('thinkingVisibilityFree'), paid: read('thinkingVisibilityPaid') };
};

/** For a caller whose tier could not be resolved: the free level, or `summary` without settings. */
export const fallbackThinkingVisibility = async (
  db: Parameters<typeof loadThinkingVisibilitySettings>[0]
): Promise<ThinkingVisibility> => {
  try {
    return (await loadThinkingVisibilitySettings(db)).free;
  } catch {
    return 'summary';
  }
};

/** The thinking visibility for one account: the paid level with paid standing, else the free level. */
export const resolveAccountThinkingVisibility = async (
  user: PaidStandingSubject,
  options: { settings: ThinkingVisibilitySettings; hasActivePlan: () => Promise<boolean> }
): Promise<ThinkingVisibility> =>
  (await hasPaidStanding(user, options.hasActivePlan)) ? options.settings.paid : options.settings.free;
