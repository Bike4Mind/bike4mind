import { IAdminSettings, IUserPreferences } from '@bike4mind/common';
import { useShallow } from 'zustand/react/shallow';
import { useQueryClient } from '@tanstack/react-query';
import React, {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { updateAllQueryData, useSubscribeCollection } from '../utils/react-query';
import { useUser } from './UserContext';
import { updateUserToServer } from '../utils/userAPICalls';
import { useLanguage } from './TranslationProvider';
import { useSettingsFromServer } from '../hooks/data/settings';

export type ExperimentalFeature =
  | 'enableQuestMaster'
  | 'enableMementos'
  | 'enableMementosV2'
  | 'enableArtifacts'
  | 'enableOllama'
  | 'enableAgents'
  | 'enableResearchMode'
  | 'enableDeepResearch'
  | 'enableRapidReply'
  | 'enableResearchEngine'
  | 'enableBmPi'
  | 'enableLattice'
  | 'enableBriefcase'
  | 'enableHearth'
  // Layer-1 gate for the Agent-mode composer toggle.
  // Hides the entire feature surface until parity ships. Default false for everyone.
  | 'agentMode';

export interface UserSettings {
  showDebug: boolean;
  showHelp: boolean;
  maxVisibleLines: number;
  autoCollapseContent: boolean;
  serverSettings: IAdminSettings[];
  enableAutoScroll: boolean;
  scrollbarWidth: number;
  experimentalFeatures: {
    [K in ExperimentalFeature]: boolean;
  };
  contextTelemetryLevel: 'none' | 'basic' | 'enhanced';
  rechartsDisplayMode: 'inline' | 'artifact';
  toolsCatalogCollapsed: boolean;
  /** Layer-2 Agent-mode preference. Default `'off'` per `IUserPreferences`. */
  agentModeDefault: 'off' | 'auto' | 'on';
  showFunTools: boolean;
}

interface UserSettingsContextProps {
  settings: UserSettings;
  /** Update local state optimistically and persist to the server. Single source of truth. */
  updatePreferences: (diff: Partial<IUserPreferences>) => void;
  /** True once a user record has been written into the UserContext store (from
   *  /api/identify, refreshUser, or a WebSocket push). Backed by an explicit,
   *  latched store flag - never derived from field presence. Consumers that
   *  branch on `settings` (e.g. feature gates) wait for this so they don't
   *  render a default-driven UI before the real values land. */
  isHydrated: boolean;
  /** Raw experimental feature preferences from the server (only keys the user has
   *  explicitly set are present - absent keys mean "use admin default"). */
  rawExperimentalPreferences: Partial<Record<ExperimentalFeature, boolean>>;
}

const UserSettingsContext = createContext<UserSettingsContextProps>({} as UserSettingsContextProps);

const defaultSettings: UserSettings = {
  showDebug: false,
  showHelp: false,
  serverSettings: [],
  maxVisibleLines: 25,
  autoCollapseContent: true,
  enableAutoScroll: true,
  scrollbarWidth: 10,
  experimentalFeatures: {
    enableQuestMaster: false,
    enableMementos: false,
    enableMementosV2: false,
    enableArtifacts: false,
    enableOllama: false,
    enableAgents: false,
    enableResearchMode: false,
    enableDeepResearch: false,
    enableRapidReply: false,
    enableResearchEngine: false,
    enableBmPi: false,
    enableLattice: false,
    enableHearth: false,
    enableBriefcase: false,
    agentMode: false,
  },
  contextTelemetryLevel: 'basic',
  rechartsDisplayMode: 'inline',
  toolsCatalogCollapsed: false,
  agentModeDefault: 'off',
  showFunTools: false,
};

/** Scalar keys shared between IUserPreferences and UserSettings. */
const SCALAR_PREF_KEYS = [
  'showDebug',
  'showHelp',
  'maxVisibleLines',
  'autoCollapseContent',
  'enableAutoScroll',
  'scrollbarWidth',
  'contextTelemetryLevel',
  'rechartsDisplayMode',
  'toolsCatalogCollapsed',
  'agentModeDefault',
  'showFunTools',
] as const;

/** Apply server preferences on top of defaults. Non-null server values win. */
function mergeServerPreferences(prefs: IUserPreferences | null | undefined): UserSettings {
  if (!prefs) return defaultSettings;

  const merged: UserSettings = { ...defaultSettings };

  // Copy scalar fields where server has a non-null value
  for (const key of SCALAR_PREF_KEYS) {
    if (prefs[key] != null) {
      Object.assign(merged, { [key]: prefs[key] });
    }
  }

  // Merge experimental features with defaults as fallback
  if (prefs.experimentalFeatures) {
    merged.experimentalFeatures = {
      ...defaultSettings.experimentalFeatures,
      ...(prefs.experimentalFeatures as Partial<Record<ExperimentalFeature, boolean>>),
    };
  }

  return merged;
}

export const UserSettingsProvider: React.FC<PropsWithChildren<{}>> = ({ children }) => {
  const queryClient = useQueryClient();

  // Local settings state - defaults until server preferences arrive
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);

  const currentUser = useUser(s => s.currentUser);
  // Hydration is tracked by an explicit, latched flag in the UserContext store
  // (flipped on the first real user write). Reading it here keeps the gate's
  // loading signal decoupled from which fields pickPersistedFields persists.
  const isHydrated = useUser(s => s.isHydrated);
  const [currentLanguage, setLanguage] = useLanguage(useShallow(s => [s.language, s.setLanguage]));

  // Track the last server preferences we applied via value comparison.
  // Reference comparison (`!==`) would fire on every WebSocket update since each
  // update creates a new object ref, even when contents are identical.
  const serverPreferences = currentUser?.preferences;
  const serverPreferencesKey = serverPreferences ? JSON.stringify(serverPreferences) : '';

  // Raw experimental feature preferences - only keys the user has explicitly set.
  // Maintained as state (not useMemo) so optimistic writes via updatePreferences take
  // effect immediately, preventing toggle desync while the server write is in-flight.
  // Synced back from the server on each WebSocket-confirmed change via rawExpKey.
  const rawExpKey = JSON.stringify(currentUser?.preferences?.experimentalFeatures ?? {});
  const [rawExperimentalPreferences, setRawExperimentalPreferences] = useState<
    Partial<Record<ExperimentalFeature, boolean>>
  >({});

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRawExperimentalPreferences(
      (currentUser?.preferences?.experimentalFeatures as Partial<Record<ExperimentalFeature, boolean>>) ?? {}
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawExpKey]);

  // Fold admin settings into local state
  const { data: serverSettingsData } = useSettingsFromServer();
  // Only hash settingName+settingValue - exclude WebSocket metadata fields (cachedUpdate,
  // updatedAt, __v, _id) so that a WebSocket push of unchanged values doesn't retrigger
  // the effect.  updateSingleQueryDataFast stamps cachedUpdate: Date.now() on every push,
  // making a full JSON.stringify always produce a different key even when values are identical.
  const serverSettingsKey = serverSettingsData
    ? JSON.stringify(serverSettingsData.map(s => ({ n: s.settingName, v: s.settingValue })))
    : '';

  // Apply server preferences when content changes (not on every reference change)
  useEffect(() => {
    if (!serverPreferences) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(() => mergeServerPreferences(serverPreferences));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverPreferencesKey]); // gate on content change, not object reference

  // Apply admin settings when content changes
  useEffect(() => {
    if (!serverSettingsData) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(prev => ({ ...prev, serverSettings: serverSettingsData }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSettingsKey]); // gate on content change, not object reference

  // Single entry point: update local state optimistically, then persist to server
  const updatePreferences = useCallback(
    (diff: Partial<IUserPreferences>) => {
      // Optimistic local update - apply diff to local settings immediately
      setSettings(prev => {
        const next = { ...prev };
        for (const key of SCALAR_PREF_KEYS) {
          if (key in diff && diff[key] != null) {
            Object.assign(next, { [key]: diff[key] });
          }
        }
        if (diff.experimentalFeatures) {
          next.experimentalFeatures = {
            ...prev.experimentalFeatures,
            ...(diff.experimentalFeatures as Partial<Record<ExperimentalFeature, boolean>>),
          };
        }
        return next;
      });
      // Also update rawExperimentalPreferences optimistically so isFeatureEnabled()
      // reflects the new value immediately (before the server echo arrives).
      if (diff.experimentalFeatures) {
        setRawExperimentalPreferences(prev => ({
          ...prev,
          ...(diff.experimentalFeatures as Partial<Record<ExperimentalFeature, boolean>>),
        }));
      }

      // Persist to server
      if (!currentUser?.id) return;
      // Known race: concurrent toggles may clobber each other if both writes are in-flight
      // simultaneously (second write reads stale currentUser.preferences). Pre-existing behavior,
      // less severe with per-key writes. Fix tracked separately.
      const fullPreferences = {
        ...currentUser.preferences,
        ...diff,
        ...(diff.experimentalFeatures
          ? {
              experimentalFeatures: {
                ...currentUser.preferences?.experimentalFeatures,
                ...diff.experimentalFeatures,
              },
            }
          : {}),
      };
      // Write through to the store, not just the server: otherwise the stale value is persisted and
      // reseeded as identify initialData (5-min staleTime skips the refetch), reverting on reload when
      // the `users` socket is silent. See useGetIdentify initialData guard.
      useUser.getState().setCurrentUser({ ...currentUser, preferences: fullPreferences });
      updateUserToServer(currentUser.id, { preferences: fullPreferences }).catch(() => {
        console.warn('[UserSettings] Failed to write preferences to server');
      });
    },
    [currentUser]
  );

  // --- Language preference: read from server on load ---
  const languageSyncedRef = useRef(false);
  useEffect(() => {
    const serverLang = currentUser?.preferences?.language;
    if (!serverLang || languageSyncedRef.current) return;
    if (serverLang !== currentLanguage) {
      languageSyncedRef.current = true;
      setLanguage(serverLang);
    }
  }, [currentUser?.preferences?.language, currentLanguage, setLanguage]);

  // --- Language preference: write back to server on change ---
  const prevLanguageRef = useRef(currentLanguage);
  useEffect(() => {
    const prev = prevLanguageRef.current;
    prevLanguageRef.current = currentLanguage;
    if (!currentUser?.id || currentLanguage === prev) return;
    // Don't sync if the change came from the server read above
    if (languageSyncedRef.current) {
      languageSyncedRef.current = false;
      return;
    }
    if (!currentUser?.id) return;
    // TODO: route through updatePreferences to pick up experimentalFeatures deep-merge
    const fullPreferences = { ...currentUser.preferences, language: currentLanguage };
    updateUserToServer(currentUser.id, { preferences: fullPreferences }).catch(() => {
      console.warn('[UserSettings] Failed to write language preference to server');
    });
  }, [currentLanguage, currentUser]);

  // One-time cleanup: remove stale localStorage keys from previous localStorage-based persistence
  useEffect(() => {
    const staleKeys = [
      'bike4mind-user-settings',
      'favoriteTags',
      'b4m-file-browser-viewMode',
      'opti-canvasser-session-id',
      'b4m-preferences-migrated',
    ];
    staleKeys.forEach(key => localStorage.removeItem(key));
  }, []);

  const adminSettingsCallback = useCallback(
    (type: string, data: IAdminSettings) => {
      const operation = type === 'delete' ? type : 'write';
      updateAllQueryData(queryClient, 'adminsettings', operation, data);
    },
    [queryClient]
  );

  useSubscribeCollection<IAdminSettings>(
    'adminsettings',
    useMemo(() => ({}), []),
    adminSettingsCallback
  );

  const contextValue = useMemo(
    () => ({ settings, updatePreferences, isHydrated, rawExperimentalPreferences }),
    [settings, updatePreferences, isHydrated, rawExperimentalPreferences]
  );

  return <UserSettingsContext.Provider value={contextValue}>{children}</UserSettingsContext.Provider>;
};

export const useServerSettings = () => {
  const { settings } = useContext(UserSettingsContext);
  return { serverSettings: settings.serverSettings };
};

export const useUserSettings = () => {
  const context = useContext(UserSettingsContext);
  if (!context) throw new Error('useUserSettings must be used within a UserSettingsProvider');
  return context;
};
