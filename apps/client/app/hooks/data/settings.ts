import { api } from '@client/app/contexts/ApiContext';
import {
  IAdminSettings,
  IScopedSetting,
  LogoSettings,
  ServerStatusEnum,
  SettingKey,
  settingsMap,
  allSettingDefinitions,
  getExperimentalFeatureSettingKeys,
  resolveSettingDefinition,
  forcedRetrievalFloorAboveMeasured,
  forcedRetrievalFloorAboveMeasuredMessage,
  isBlankSettingValue,
  isSupportedEmbeddingModel,
  OpenAIEmbeddingModel,
} from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import type { ServerConfig } from '@pages/api/settings/serverConfig';
import type { ServerConfigPublic } from '@pages/api/settings/serverConfigPublic';
import type { ScopedOverrideDeleteQuery, ScopedOverridePutBody } from '@pages/api/admin/scoped-settings';
import {
  ADMIN_SETTINGS_QUERY_KEY,
  ADMIN_SETTINGS_ARRAY_QUERY_KEY,
  BRANDING_SETTINGS_QUERY_KEY,
  SCOPED_SETTING_OVERRIDES_QUERY_KEY,
  SERVER_CONFIG_QUERY_KEY,
} from './queryKeys';
import { useAccessToken, useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      key,
      value,
      confirmClear,
      confirmAboveMeasuredFloor,
    }: {
      key: SettingKey;
      value: z.TypeOf<(typeof settingsMap)[SettingKey]['schema']>;
      // Required by the server to unset a sensitive setting - clearing one destroys a live
      // credential, so the intent has to be explicit rather than inferred from an empty value.
      confirmClear?: boolean;
      // Sent only after the field has shown useFloorAboveMeasuredWarning's text.
      confirmAboveMeasuredFloor?: boolean;
    }) => {
      const { data } = await api.put(`/api/settings/update`, {
        key,
        value,
        ...(confirmClear ? { confirmClear } : {}),
        ...(confirmAboveMeasuredFloor ? { confirmAboveMeasuredFloor } : {}),
      });

      return data;
    },
    // Returning the invalidations keeps `isPending` true until the refetched settings are cached,
    // so callers never re-enable controls against stale values.
    onSuccess: (data, variables) => {
      const invalidations = [
        // Both admin settings caches (object format and array format)
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY }),
      ];

      // Also invalidate branding settings when updating logo settings
      if (variables.key === 'logoSettings') {
        invalidations.push(queryClient.invalidateQueries({ queryKey: BRANDING_SETTINGS_QUERY_KEY }));
      }

      return Promise.all(invalidations);
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
    // A contributed flag reaches a non-admin only with `userReadable: true`; otherwise they get its default.
    const allowedSettings = getExperimentalFeatureSettingKeys();

    // Merge database settings with defaults, converting to string for consistency
    return allowedSettings.map(settingName => {
      const dbSetting = allSettings?.find(s => s.settingName === settingName);
      const defaultSetting = resolveSettingDefinition(settingName);

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

/**
 * Every live org/owner/lake override row, at any rung, for every setting - the whole (small by
 * design) overlay collection in one read. The admin UI slices it two ways: per setting ("which
 * rungs override this") and per scope address ("what is overridden here"), so both views share one
 * query rather than one request each.
 */
export function useScopedSettingOverrides() {
  // Admin-only endpoint behind auth; gate on a token the way useSettingsFromServer does so an
  // unauthenticated mount does not fire a guaranteed 401.
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  return useQuery({
    queryKey: SCOPED_SETTING_OVERRIDES_QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<IScopedSetting[]>('/api/admin/scoped-settings');
      return response.data;
    },
    enabled: hasAccessToken,
  });
}

/** Set or change the override at one (rung, setting) address. Writing to an address that already
 * has a row is an upsert, so this is both "add" and "change". */
export function useSetScopedSettingOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ScopedOverridePutBody) => {
      const { data } = await api.put('/api/admin/scoped-settings', body);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCOPED_SETTING_OVERRIDES_QUERY_KEY });
    },
  });
}

export function useClearScopedSettingOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    // The address travels as query params, not a body - see the route.
    mutationFn: async (params: ScopedOverrideDeleteQuery) => {
      const { data } = await api.delete('/api/admin/scoped-settings', { params });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCOPED_SETTING_OVERRIDES_QUERY_KEY });
    },
  });
}

export function useGetSettingsValue(key: SettingKey) {
  const settingConfigs = useMemo(() => allSettingDefinitions(), []);
  const { data: settingsFromServer } = useSettingsFromServer();

  return useMemo(() => {
    const serverSetting = settingsFromServer?.find(settings => settings.settingName === key);
    const defaultSetting = settingConfigs.find(settings => settings.key === key);

    return serverSetting?.settingValue ?? defaultSetting?.defaultValue;
  }, [key, settingsFromServer, settingConfigs]);
}

/**
 * The warning an admin field shows before saving a forced-retrieval floor above the one measured for
 * the default embedding model; the server refuses that value unless the save confirms it.
 */
export function useFloorAboveMeasuredWarning(key: SettingKey, value: unknown): string | undefined {
  const model = useGetSettingsValue('defaultEmbeddingModel');
  if (key !== 'forcedRetrievalMinSimilarityPct' || typeof model !== 'string' || isBlankSettingValue(value)) {
    return undefined;
  }
  // Mirror `resolveDefaultEmbeddingModel` on the server: the stored value is the model only while it
  // is supported, and an unsupported one falls back to 3-small - the floor the server refuses
  // against. Without this the two sides disagree when the stored value is stale or legacy, and a
  // save the client never warned about is refused with no way to confirm it from here.
  const resolvedModel = isSupportedEmbeddingModel(model) ? model : OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;
  const pct = Number(value);
  const measured = Number.isFinite(pct) ? forcedRetrievalFloorAboveMeasured(pct, resolvedModel) : undefined;
  return measured === undefined ? undefined : forcedRetrievalFloorAboveMeasuredMessage(pct, measured, resolvedModel);
}

/**
 * The embedding model this deployment will actually embed with, or undefined while it is unknown.
 *
 * Use this, NOT `useGetSettingsValue('defaultEmbeddingModel')`, for anything that compares a file's
 * recorded `embeddingModel` label. The setting is what the deployment ADVERTISES and is deliberately
 * stage-neutral (it is bundled into this browser build, where no credential is visible); a stage
 * holding no key for it embeds and stamps with the keyless Bedrock model instead. Comparing labels
 * to the advertised value therefore reports every correctly-embedded file on such a stage as living
 * in a foreign vector space. Only the server can resolve this - see `computeEffectiveEmbeddingModel`.
 *
 * Undefined means "not resolved yet, or this deployment cannot embed at all". Callers must treat it
 * as unknown and suppress the comparison rather than falling back to the advertised setting, which
 * is the substitution that produces the false mismatch in the first place.
 */
export function useEffectiveEmbeddingModel(): string | undefined {
  const { data: config } = useConfig();
  return config?.effectiveEmbeddingModel || undefined;
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
    queryKey: SERVER_CONFIG_QUERY_KEY,
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
