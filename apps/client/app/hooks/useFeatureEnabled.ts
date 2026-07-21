import { useCallback } from 'react';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useAdminSettingsCache } from './useAdminSettingsCache';
import type { ExperimentalFeature } from '@client/app/contexts/UserSettingsContext';

interface FeatureMeta {
  /** Admin key that gates the feature. Absent means no admin gate - feature is user-controlled only. */
  adminKey?: string;
  /** Admin-settable default key. Absent means this feature has no admin default. */
  defaultKey?: string;
}

const featureMeta: Record<ExperimentalFeature, FeatureMeta> = {
  enableArtifacts: { adminKey: 'EnableArtifacts', defaultKey: 'EnableArtifactsDefault' },
  enableAgents: { adminKey: 'EnableAgents', defaultKey: 'EnableAgentsDefault' },
  enableRapidReply: { adminKey: 'EnableRapidReply', defaultKey: 'EnableRapidReplyDefault' },
  enableResearchEngine: { adminKey: 'EnableResearchEngine', defaultKey: 'EnableResearchEngineDefault' },
  enableQuestMaster: { adminKey: 'EnableQuestMaster', defaultKey: 'EnableQuestMasterDefault' },
  enableQuestMasterV5: { adminKey: 'EnableQuestMasterV5', defaultKey: 'EnableQuestMasterV5Default' },
  enableMementos: { adminKey: 'EnableMementos', defaultKey: 'EnableMementosDefault' },
  // User-controlled only (no admin SettingKey yet) - a per-user opt-in to the Mementos 2.0 ledger,
  // peer to V1. Promote to an admin-gated flag when rolling out org-wide.
  enableMementosV2: {},
  enableOllama: { adminKey: 'EnableOllama', defaultKey: 'EnableOllamaDefault' },
  enableDeepResearch: { adminKey: 'EnableDeepResearch', defaultKey: 'EnableDeepResearchDefault' },
  enableBmPi: { adminKey: 'EnableBmPi', defaultKey: 'EnableBmPiDefault' },
  enableLattice: { adminKey: 'EnableLattice', defaultKey: 'EnableLatticeDefault' },
  enableBriefcase: { adminKey: 'EnableBriefcase', defaultKey: 'EnableBriefcaseDefault' },
  // enableResearchMode has no admin SettingKey - it is user-controlled only
  enableResearchMode: {},
  // agentMode is the Layer-1 gate for the Agent-mode / Smart Routing toggle UI.
  // Admin-gated by EnableAgentMode (master availability) with
  // EnableAgentModeDefault as the opt-in default, so it can be rolled out and
  // killed org-wide from the admin console instead of per-account DB edits.
  agentMode: { adminKey: 'EnableAgentMode', defaultKey: 'EnableAgentModeDefault' },
};

/**
 * Hook to check if a feature is enabled.
 * For all admin-gated features, falls back to the admin-settable default when the
 * user has never explicitly set the preference.
 *
 * @example
 * const { isFeatureEnabled } = useFeatureEnabled();
 * const agentsEnabled = isFeatureEnabled('enableAgents');
 *
 * @example
 * // For admin-only features (no user toggle)
 * const { isAdminFeatureEnabled } = useFeatureEnabled();
 * const deepResearchEnabled = isAdminFeatureEnabled('EnableDeepResearch');
 */
export function useFeatureEnabled() {
  const { rawExperimentalPreferences, isHydrated: userHydrated } = useUserSettings();
  const { isFeatureEnabled: isAdminFeatureEnabled, isLoading: adminLoading } = useAdminSettingsCache();

  const isFeatureEnabled = useCallback(
    (feature: ExperimentalFeature): boolean => {
      const { adminKey, defaultKey } = featureMeta[feature];
      if (adminKey && !isAdminFeatureEnabled(adminKey)) return false;

      const explicitValue = rawExperimentalPreferences[feature];
      if (explicitValue !== undefined) return explicitValue;

      // No explicit user preference - fall back to admin's default setting (or false if none)
      return defaultKey ? isAdminFeatureEnabled(defaultKey) : false;
    },
    [rawExperimentalPreferences, isAdminFeatureEnabled]
  );

  return {
    isFeatureEnabled,
    isAdminFeatureEnabled,
    /** True while either admin settings or the user's preferences are still
     *  loading. Both signals must resolve before the feature decision is known,
     *  so gate UIs should suppress their disabled branch until this is false -
     *  otherwise legitimately-enabled users see a flash of the gate during
     *  any of: pre-token bootstrap, admin fetch, or user prefs hydration. */
    isLoading: adminLoading || !userHydrated,
  };
}
