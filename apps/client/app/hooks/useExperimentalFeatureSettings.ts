import { useUserSettings } from '@client/app/contexts/UserSettingsContext';

export function useExperimentalFeatureSettings() {
  const { settings } = useUserSettings();
  return {
    settings: settings.experimentalFeatures,
  };
}
