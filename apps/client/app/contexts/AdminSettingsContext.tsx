'use client';

import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './ApiContext';
import { settingsMap } from '@bike4mind/common';
import { ADMIN_SETTINGS_QUERY_KEY } from '@client/app/hooks/data/queryKeys';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

interface AdminSetting {
  settingName: string;
  settingValue: string | boolean | number | object;
  type?: string;
  description?: string;
  // MongoDB fields
  _id?: string;
  createdAt?: string;
  updatedAt?: string;
  __v?: number;
}

interface AdminSettingsContextValue {
  settings: Record<string, string | object>;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  getSetting: (key: string, defaultValue?: string) => string | object;
  getSettingBoolean: (key: string, defaultValue?: boolean) => boolean;
  getSettingNumber: (key: string, defaultValue?: number) => number;
  getSettingObject: <T = object>(key: string, defaultValue?: T) => T | null;
}

const AdminSettingsContext = createContext<AdminSettingsContextValue | null>(null);

export const useAdminSettings = () => {
  const context = useContext(AdminSettingsContext);
  if (!context) {
    throw new Error('useAdminSettings must be used within AdminSettingsProvider');
  }
  return context;
};

interface AdminSettingsProviderProps {
  children: React.ReactNode;
  /** Cache TTL in milliseconds. Default: 5 minutes */
  cacheTTL?: number;
  /** Whether to fetch settings immediately on mount. Default: true */
  fetchOnMount?: boolean;
}

// Query key imported from shared constants (apps/client/app/hooks/data/queryKeys.ts)

// S3 key / CloudFront path for the public settings artifact (M2.5). Kept in sync with
// PUBLIC_SETTINGS_KEY in apps/client/server/utils/publicSettingsArtifact.ts.
const PUBLIC_SETTINGS_PATH = 'app-config/public-settings.json';

// Query key for the ungated CDN artifact (distinct from the authed settings query).
export const PUBLIC_SETTINGS_QUERY_KEY = ['publicSettings'] as const;

interface PublicSettingsArtifact {
  version: number;
  updatedAt: string;
  settings: AdminSetting[];
}

const toSettingValue = (value: AdminSetting['settingValue']): string | object =>
  typeof value === 'object' && value !== null ? value : typeof value === 'string' ? value : String(value);

// Merge a list of settings over the settingsMap defaults into a flat key/value map.
const mergeIntoDefaults = (list: AdminSetting[]): Record<string, string | object> => {
  const merged = Object.entries(settingsMap).reduce(
    (acc, [key, config]) => {
      acc[key] = toSettingValue(config.defaultValue as AdminSetting['settingValue']);
      return acc;
    },
    {} as Record<string, string | object>
  );
  for (const setting of list) merged[setting.settingName] = toSettingValue(setting.settingValue);
  return merged;
};

// Fetch function for admin settings (authenticated, source of truth).
const fetchAdminSettings = async (): Promise<Record<string, string | object>> => {
  const startTime = Date.now();
  const response = await api.get<AdminSetting[]>('/api/settings/fetch');
  const mergedSettings = mergeIntoDefaults(response.data);
  const fetchTime = Date.now() - startTime;
  console.log(
    `✅ [AdminSettings] Fetched ${response.data.length} settings from DB, merged with ${Object.keys(settingsMap).length} defaults (${fetchTime}ms)`
  );
  return mergedSettings;
};

/**
 * Fetch the PUBLIC settings artifact from the CDN (M2.5). Unauthenticated, no Lambda,
 * no DB, served in ms from CloudFront. Hydrates startup config (e.g. enforceMFA)
 * before/without the authenticated fetch, which then reconciles in the background.
 *
 * Uses a same-origin relative URL: the app and the artifact are served by the same
 * CloudFront router in deployed envs, so a relative path resolves to the same
 * distribution without depending on `NEXT_PUBLIC_CDN_URL` being inlined at build time
 * (it isn't in the prod/staging client bundles, which silently disabled this fast-path).
 *
 * Returns null on any failure (missing artifact, network) so the authed path remains
 * the source of truth and nothing breaks.
 */
const fetchPublicSettingsArtifact = async (): Promise<Record<string, string | object> | null> => {
  try {
    const res = await fetch(`/${PUBLIC_SETTINGS_PATH}`, { credentials: 'omit' });
    if (!res.ok) return null;
    const artifact = (await res.json()) as PublicSettingsArtifact;
    if (!Array.isArray(artifact?.settings)) return null;
    return mergeIntoDefaults(artifact.settings);
  } catch {
    return null;
  }
};

export const AdminSettingsProvider: React.FC<AdminSettingsProviderProps> = ({
  children,
  cacheTTL = 5 * 60 * 1000, // 5 minutes default
  fetchOnMount = true,
}) => {
  // The endpoint requires auth; gate the query so anonymous mounts (e.g. brief
  // mount during the redirect from `/` to `/login`) don't fire a guaranteed 401.
  const hasAccessToken = useAccessToken(state => !!state.accessToken);

  // Public CDN artifact (M2.5): ungated, runs immediately without a token, served in ms
  // from CloudFront. Seeds startup-critical publicSafe settings (e.g. enforceMFA) so the
  // "Checking security settings..." gate resolves before the authenticated fetch returns.
  const { data: publicSettings } = useQuery({
    queryKey: PUBLIC_SETTINGS_QUERY_KEY,
    queryFn: fetchPublicSettingsArtifact,
    staleTime: cacheTTL,
    gcTime: 24 * 60 * 60 * 1000,
    enabled: fetchOnMount,
    retry: false,
  });

  // Authenticated settings (source of truth); reconciles over the public artifact.
  const {
    data: authedSettings,
    isPending,
    error,
    refetch,
  } = useQuery({
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
    queryFn: fetchAdminSettings,
    staleTime: cacheTTL, // Consider data fresh for cacheTTL duration
    gcTime: 24 * 60 * 60 * 1000, // 24 hours - when to garbage collect from IndexedDB
    refetchInterval: cacheTTL, // Background refetch interval
    refetchOnWindowFocus: true, // Refetch on window focus for responsive admin setting updates
    enabled: fetchOnMount && hasAccessToken,
    retry: false, // Never retry (429 or 500): this query runs every 5 min via refetchInterval; retrying throttled/errored requests amplifies Lambda saturation storms
  });

  // Authenticated data wins (full + freshest); the public artifact fills in early/anonymously.
  const settings = useMemo<Record<string, string | object>>(
    () => ({ ...(publicSettings ?? {}), ...(authedSettings ?? {}) }),
    [publicSettings, authedSettings]
  );

  // Helper functions for type-safe setting access
  const getSetting = useCallback(
    (key: string, defaultValue: string = ''): string | object => {
      const value = settings[key];
      if (value === undefined || value === null) return defaultValue;
      return value;
    },
    [settings]
  );

  const getSettingBoolean = useCallback(
    (key: string, defaultValue: boolean = false): boolean => {
      const value = settings[key];
      if (!value || typeof value === 'object') return defaultValue;
      const stringValue = String(value);
      return stringValue.toLowerCase() === 'true' || stringValue === '1';
    },
    [settings]
  );

  const getSettingNumber = useCallback(
    (key: string, defaultValue: number = 0): number => {
      const value = settings[key];
      if (!value || typeof value === 'object') return defaultValue;
      const parsed = parseFloat(String(value));
      return isNaN(parsed) ? defaultValue : parsed;
    },
    [settings]
  );

  const getSettingObject = useCallback(
    <T = object,>(key: string, defaultValue?: T): T | null => {
      const value = settings[key];
      if (!value) return defaultValue ?? null;
      if (typeof value === 'object') return value as T;

      // Try to parse string as JSON
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as T;
        } catch (error) {
          console.warn(`Failed to parse setting "${key}" as JSON:`, error);
          return defaultValue ?? null;
        }
      }

      return defaultValue ?? null;
    },
    [settings]
  );

  // dataUpdatedAt is intentionally excluded from deps: it changes on every background
  // refetch (window focus, interval) even when settings content is unchanged, which would
  // cause all consumers to re-render on every refetch.
  const contextValue: AdminSettingsContextValue = useMemo(() => {
    return {
      settings,
      // Treat the gated (anonymous) state as "settled with defaults" rather than loading:
      // react-query keeps `isPending` true while a query is disabled, which would render a
      // perpetual loading skeleton on /login if any consumer mounts during the redirect.
      // M2.5: once the public CDN artifact has loaded, the startup-critical publicSafe
      // settings (enforceMFA) are available, so we stop blocking the UI even while the
      // authenticated fetch is still reconciling in the background.
      isLoading: hasAccessToken && isPending && !publicSettings,
      error: error ? (error instanceof Error ? error.message : 'Failed to fetch admin settings') : null,
      refetch: async () => {
        await refetch();
      },
      getSetting,
      getSettingBoolean,
      getSettingNumber,
      getSettingObject,
    };
  }, [
    settings,
    hasAccessToken,
    isPending,
    publicSettings,
    error,
    refetch,
    getSetting,
    getSettingBoolean,
    getSettingNumber,
    getSettingObject,
  ]);

  return <AdminSettingsContext.Provider value={contextValue}>{children}</AdminSettingsContext.Provider>;
};

export default AdminSettingsContext;
