/**
 * Drop-in replacement for server-side admin settings calls, backed by a
 * client-side cache to eliminate redundant API requests. `data`, `isLoading`,
 * and `isSuccess` match the old useSettingsFromServer hook.
 *
 * @example
 * const { isFeatureEnabled } = useAdminSettingsCache();
 * const enableQuestMaster = isFeatureEnabled('EnableQuestMaster');
 */

import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useCallback, useMemo } from 'react';

export interface CachedAdminSetting {
  key: string;
  value: string | object;
  settingName: string;
  settingValue: string | object;
}

/**
 * Cached admin settings with the same interface as the server-side calls.
 *
 * @returns cached settings plus helper accessors
 */
export const useAdminSettingsCache = () => {
  const { settings, isLoading, error, getSetting, getSettingBoolean, getSettingNumber, refetch } = useAdminSettings();

  // Memoize the array conversion; stable as long as the settings object is.
  // Object.entries().map() on every render creates a new array reference,
  // destabilizing any consumer that passes the array as a dep.
  const settingsArray = useMemo(
    (): CachedAdminSetting[] =>
      Object.entries(settings).map(([key, value]) => ({
        key,
        value,
        settingName: key,
        settingValue: value,
      })),
    [settings]
  );

  const isFeatureEnabled = useCallback(
    (featureName: string): boolean => {
      return getSettingBoolean(featureName, false);
    },
    [getSettingBoolean]
  );

  const getApiKey = useCallback(
    (keyName: string): string | null => {
      const value = getSetting(keyName, '');
      return String(value) || null;
    },
    [getSetting]
  );

  return {
    settings,
    settingsArray,

    isLoading,
    error,

    getSetting,
    getSettingBoolean,
    getSettingNumber,
    isFeatureEnabled,
    getApiKey,

    refetch,

    // Compatibility alias for existing code that expects 'data' property
    data: settingsArray,
    isSuccess: !isLoading && !error,
    isError: !!error,
  };
};

/**
 * Direct replacement for getSettingsMap server calls
 * Returns cached settings map immediately if available
 *
 * @example
 * const { settingsMap, isReady } = useCachedSettingsMap();
 * if (isReady) {
 *   const enableQuestMaster = settingsMap['EnableQuestMaster'] === 'true';
 * }
 */
export const useCachedSettingsMap = () => {
  const { settings, isLoading } = useAdminSettings();

  return {
    settingsMap: settings,
    isLoading,
    isReady: !isLoading && Object.keys(settings).length > 0,
  };
};

/**
 * Hook for checking multiple feature flags at once
 *
 * @example
 * const features = useFeatureFlags(['EnableQuestMaster', 'EnableMementos', 'EnableAgents']);
 * if (features.EnableQuestMaster && features.EnableAgents) {
 *   // Both features are enabled
 * }
 */
export const useFeatureFlags = (features: string[]) => {
  const { getSettingBoolean } = useAdminSettings();

  return features.reduce(
    (acc, feature) => {
      acc[feature] = getSettingBoolean(feature, false);
      return acc;
    },
    {} as Record<string, boolean>
  );
};

export default useAdminSettingsCache;
