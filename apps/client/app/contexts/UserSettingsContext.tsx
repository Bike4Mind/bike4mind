import { IAdminSettings, IUserPreferences } from '@bike4mind/common';
import { useShallow } from 'zustand/react/shallow';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError, isCancel } from 'axios';
import { toast } from 'sonner';
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
import { getAxiosRetryCount } from './ApiContext';
import { updateAllQueryData, useSubscribeCollection } from '../utils/react-query';
import { useUser } from './UserContext';
import { updateUserToServer } from '../utils/userAPICalls';
import { useLanguage } from './TranslationProvider';
import { useSettingsFromServer } from '../hooks/data/settings';

export type ExperimentalFeature =
  | 'enableQuestMaster'
  | 'enableQuestMasterV5'
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
  /** Whether generated audio (TTS, sound-effect, music) is saved as a browsable FabFile. Default: true. */
  saveGeneratedAudio: boolean;
  showSplashCards: boolean;
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
    enableQuestMasterV5: false,
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
  saveGeneratedAudio: true,
  showSplashCards: false,
};

// One id for every settings-write failure - preferences AND language - so a burst of failures
// collapses into a single toast instead of stacking one per key. Sharing it across both paths is
// deliberate: the user only needs to know a save failed, not how many did.
const SETTINGS_WRITE_TOAST_ID = 'settings-write-failed';

/**
 * Whether a failed preferences write is worth telling the user about.
 *
 * A cancel is user-initiated. A 401 is silenced only when the interceptor tore the session
 * down cleanly - `getAxiosRetryCount(error) === 0` means it redirected rather than retried,
 * so a toast would stack noise on a teardown the user cannot act on. A non-zero count means
 * the interceptor attempted a refresh cycle and still failed (a refresh-endpoint outage, or a
 * retry that 401'd again); the user keeps a working page, so their lost change needs saying.
 * See ApiContext's response interceptor.
 */
function shouldNotifyWriteFailure(error: unknown): boolean {
  if (isCancel(error)) return false;
  if (isAxiosError(error)) {
    if (error.code === 'ERR_CANCELED') return false;
    if (error.response?.status === 401 && getAxiosRetryCount(error) === 0) return false;
  }
  return true;
}

// Statuses where the handler's own `error` string describes a rejected VALUE, so it is written
// for the user (a rejected preference names its field). Everything else - notably the 5xx
// catch-all in server/middlewares/errorHandler.ts, which sets `error: errorObj.message` from
// whatever was thrown - can carry raw exception text naming hosts, collections or indexes.
const USER_FACING_ERROR_STATUSES = new Set([400, 409, 422]);

/**
 * The server's own message when it sent a usable one (a rejected preference value says which
 * field it rejected), otherwise the caller's generic line.
 *
 * Gated on status rather than trusting `data.error` outright: the same field carries curated
 * text on a validation reject and raw exception text on an unmapped 5xx, and the latter is
 * both internal-detail disclosure and useless to the user.
 */
function writeFailureMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status !== undefined && USER_FACING_ERROR_STATUSES.has(status)) {
      const serverError = (error.response?.data as { error?: unknown } | undefined)?.error;
      if (typeof serverError === 'string' && serverError.trim()) return serverError;
    }
  }
  return fallback;
}

/**
 * Persist a preferences write and make a failure visible instead of console-only.
 *
 * Callers apply their optimistic update first, so a rejected write leaves the UI showing a
 * value the server does not have - which is why `rollback` runs on every failure, not just
 * the ones we toast. Callers guard their own rollback against clobbering a newer write.
 */
async function persistPreferences(
  userId: string,
  preferences: IUserPreferences,
  { logLabel, fallbackMessage, rollback }: { logLabel: string; fallbackMessage: string; rollback: () => void }
): Promise<void> {
  try {
    await updateUserToServer(userId, { preferences });
  } catch (error) {
    // The console stays the only place the two write paths are told apart, so keep them named.
    console.warn(`[UserSettings] Failed to write ${logLabel} to server`, error);
    // The write did not land, so undo the optimistic value whether or not we say so.
    rollback();
    if (shouldNotifyWriteFailure(error)) {
      toast.error(writeFailureMessage(error, fallbackMessage), { id: SETTINGS_WRITE_TOAST_ID });
    }
  }
}

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
  'saveGeneratedAudio',
  'showSplashCards',
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

  // Apply server preferences when content changes (not on every reference change).
  // An absent preferences object is a real state, not just "not loaded yet" - the model
  // defaults it to null - so it must reset the derived values rather than be skipped.
  // Skipping it would strand a failed write's optimistic value on screen for any user who
  // has never saved a preference. serverSettings comes from the admin effect below and is
  // carried over, since mergeServerPreferences only knows about preference-derived fields.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(prev => ({ ...mergeServerPreferences(serverPreferences), serverSettings: prev.serverSettings }));
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
      //
      // The rollback below interacts with that race a second way: same-tick writes share a stale
      // snapshot, so if the FIRST succeeds and a LATER one fails, the later rollback passes its
      // reference guard (the store still holds its own object) and restores the shared pre-race
      // snapshot - dropping the first write's value from the store even though the server kept
      // it. Self-heals on the next server echo or reload. Fixing it properly means resolving the
      // clobber race above, not adding another guard here.
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
      const previousPreferences = currentUser.preferences;
      useUser.getState().setCurrentUser({ ...currentUser, preferences: fullPreferences });
      void persistPreferences(currentUser.id, fullPreferences, {
        logLabel: 'preferences',
        fallbackMessage: 'Could not save your preference change. Please try again.',
        rollback: () => {
          const store = useUser.getState();
          // The store holds the very object this write set, so a different reference means a
          // newer write (or a server echo) landed after us and must not be undone.
          if (!store.currentUser || store.currentUser.preferences !== fullPreferences) return;
          // Restore only preferences: other fields may have moved since (a credits push, say),
          // and reinstating the whole snapshot would revert those too.
          store.setCurrentUser({ ...store.currentUser, preferences: previousPreferences });
          // The restored snapshot predates any concurrent write that DID land (see the race
          // note above). identify is seeded from the store behind a 5-minute staleTime, so
          // without this the wrong value can be served - and re-persisted - until a socket
          // push happens to arrive. Ask for a reconcile instead of waiting for one.
          void queryClient.invalidateQueries({ queryKey: ['identify'] });
        },
      });
    },
    [currentUser, queryClient]
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
    // TODO: route through updatePreferences to pick up experimentalFeatures deep-merge. Until
    // then this spread persists whatever experimentalFeatures currentUser held when the effect
    // ran, so an experimental toggle still in flight when the language changes is dropped from
    // the persisted set.
    const fullPreferences = { ...currentUser.preferences, language: currentLanguage };
    void persistPreferences(currentUser.id, fullPreferences, {
      logLabel: 'language preference',
      fallbackMessage: 'Could not save your language preference. Please try again.',
      rollback: () => {
        // Unlike the preferences write there is no optimistic store entry to undo - the
        // language lives in its own store, and it is the visible UI language that has to go
        // back. Skip if the user has since picked another language: theirs must win.
        if (useLanguage.getState().language !== currentLanguage) return;
        // Reuse the server-read path's suppression flag so the write-back effect treats this
        // as a programmatic change and does not echo the rollback to the server.
        languageSyncedRef.current = true;
        setLanguage(prev);
      },
    });
  }, [currentLanguage, currentUser, setLanguage]);

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
