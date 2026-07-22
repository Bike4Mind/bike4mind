import { api } from '@client/app/contexts/ApiContext';
import {
  IAdminSettings,
  LogoSettings,
  ServerStatusEnum,
  SettingKey,
  settingsMap,
  experimentalFeatureSettingKeys,
} from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import type { ServerConfig } from '@pages/api/settings/serverConfig';
import type { ServerConfigPublic } from '@pages/api/settings/serverConfigPublic';
import { ADMIN_SETTINGS_QUERY_KEY, ADMIN_SETTINGS_ARRAY_QUERY_KEY, BRANDING_SETTINGS_QUERY_KEY } from './queryKeys';
import { useAccessToken, useIsFullyAuthenticated } from '../useAccessToken';

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      key,
      value,
    }: {
      key: SettingKey;
      value: z.TypeOf<(typeof settingsMap)[SettingKey]['schema']>;
    }) => {
      const { data } = await api.put(`/api/settings/update`, {
        key,
        value,
      });

      return data;
    },
    onSuccess: (data, variables) => {
      // Invalidate both admin settings caches (object format and array format)
      queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });

      // Also invalidate branding settings when updating logo settings
      if (variables.key === 'logoSettings') {
        queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY });
      }
    },
  });
}

export function useExperimentalFeatureSettings() {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  const { data: allSettings, isLoading: isPending } = useSettingsFromServer();
  // Mirror the AdminSettingsContext gating: when disabled, react-query keeps `isPending`
  // true forever, which would surface as a perpetual loading state in consumers like
  // ExperimentalFeatureToggle even though the merged defaults are immediately available.
  const isLoading = hasAccessToken && isPending;

  const experimentalSettings = useMemo(() => {
    // Single source of truth: derived from the schema's EXPERIMENTAL group
    // in @bike4mind/common, so a new experimental flag added to `settingsMap` is
    // surfaced here automatically - no second hand-maintained allowlist to forget.
    const allowedSettings = experimentalFeatureSettingKeys;

    // Merge database settings with defaults, converting to string for consistency
    return allowedSettings.map(settingName => {
      const dbSetting = allSettings?.find(s => s.settingName === settingName);
      const defaultSetting = settingsMap[settingName];

      // Get raw value (from DB or default) and convert to string
      const rawValue = dbSetting?.settingValue ?? defaultSetting?.defaultValue;
      // IAdminSettings settingValue is a string
      const stringValue = String(rawValue);

      return {
        settingName,
        settingValue: stringValue,
      } as IAdminSettings;
    });
  }, [allSettings]);

  return { data: experimentalSettings, isLoading };
}

/** @internal */
export function useSettingsFromServer() {
  // The endpoint requires auth; gating here prevents a guaranteed 401 when
  // unauthenticated consumers (e.g. components rendered on /login via feature
  // flags or footer logic) mount this hook. Mirrors useConfig() below.
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<IAdminSettings[]>(`/api/settings/fetch`);
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    enabled: hasAccessToken,
  });
}

export function useGetSettingsValue(key: SettingKey) {
  const settingConfigs = useMemo(() => Object.values(settingsMap), []);
  const { data: settingsFromServer } = useSettingsFromServer();

  return useMemo(() => {
    const serverSetting = settingsFromServer?.find(settings => settings.settingName === key);
    const defaultSetting = settingConfigs.find(settings => settings.key === key);

    return serverSetting?.settingValue ?? defaultSetting?.defaultValue;
  }, [key, settingsFromServer, settingConfigs]);
}

// Public hook for branding settings (doesn't require authentication)
export function useBrandingSettings() {
  return useQuery({
    queryKey: BRANDING_SETTINGS_QUERY_KEY,
    queryFn: async (): Promise<{
      logoSettings: LogoSettings;
      tagLineMain: string;
      tagLineSub: string;
    }> => {
      const response = await api.get<{
        logoSettings: LogoSettings;
        tagLineMain: string;
        tagLineSub: string;
      }>('/api/settings/logo');
      return response.data;
    },
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: true,
  });
}

// Convenience hook for just logo settings (backward compatibility)
export function useLogoSettings() {
  const { data: brandingSettings } = useBrandingSettings();
  return {
    data: brandingSettings?.logoSettings,
  };
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['server-config-public'],
    queryFn: async () => {
      const response = await api.get<ServerConfigPublic>('/api/settings/serverConfigPublic');
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

export function useConfig() {
  const isFullyAuthenticated = useIsFullyAuthenticated();

  return useQuery({
    queryKey: ['server-config'],
    queryFn: async () => {
      const response = await api.get<ServerConfig>('/api/settings/serverConfig');

      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
    // Only fetch when fully authenticated - prevents a 401 race on first login where
    // useConfig fires before setAccessToken runs, permanently erroring the query
    // and leaving the WebSocket URL undefined (stuck on "pending"). Gating on the
    // fully-authenticated state (not just a token) also keeps it quiet during the
    // mfaPending window (#804), where a token exists but every request 401s.
    enabled: isFullyAuthenticated,
    // Override global retry: false - this query provides the WebSocket URL,
    // so transient failures should not permanently block the connection.
    // Skip retries on 401 (unauthenticated) to avoid spurious console errors on login page.
    retry: (failureCount, error) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 401) return false;
      return failureCount < 3;
    },
  });
}

export function useServerStatus() {
  return useQuery({
    queryKey: ['server-status'],
    queryFn: async () => {
      const response = await api.get<{ serverStatus: ServerStatusEnum }>('/api/settings/serverStatus');

      return response.data;
    },
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: true,
  });
}
