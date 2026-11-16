import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { LLMModelConfig, ModelInfo, MODEL_ACCESS_REVISION_HEADER } from '@bike4mind/common';
import { MODEL_CONFIGURATIONS_QUERY_KEY } from './modelAccessRevision';
import {
  ModelConfigurationsResponseSchema,
  loadedAccessEntry,
  type LoadedModelConfiguration,
  type ModelConfigurationsRead,
} from './modelAccessDraft';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

/** Model access entries. Writes go through the per-model and bulk access endpoints (hooks/data/adminModels.ts). */
export function useLLMModelConfigurations() {
  return useQuery({
    queryKey: MODEL_CONFIGURATIONS_QUERY_KEY,
    queryFn: async (): Promise<ModelConfigurationsRead> => {
      const response = await api.get<unknown>('/api/admin/llm-models/configurations');
      const parsed = ModelConfigurationsResponseSchema.parse(response.data);
      const revision: unknown = response.headers?.[MODEL_ACCESS_REVISION_HEADER];
      return {
        configurations: parsed.settingValue,
        revision: typeof revision === 'string' && revision.length > 0 ? revision : null,
      };
    },
    select: (read: ModelConfigurationsRead) => read.configurations,
    staleTime: 1000 * 30, // 30 seconds - reduced from 5 minutes for quicker updates
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}

/**
 * Hook that combines fetching current configurations with model info to create initial configs.
 * `modelInfosPending` should come from the model-info query's own status: inferring it from
 * missing data reports a failed fetch as loading forever, hiding the no-models warning.
 */
export function useLLMModelConfigurationsWithDefaults(modelInfos?: ModelInfo[], modelInfosPending = !modelInfos) {
  const { data: savedConfigurations, isLoading, error, refetch } = useLLMModelConfigurations();

  const configurations = useMemo(() => {
    if (!modelInfos || isLoading || (error && savedConfigurations === undefined)) {
      return [];
    }

    // Merge saved configurations with model info, preferring saved configurations
    return modelInfos.map((modelInfo): LoadedModelConfiguration => {
      const savedConfig = savedConfigurations?.find(config => config.id === modelInfo.id);

      if (savedConfig) {
        return {
          ...modelInfo,
          ...savedConfig,
          id: modelInfo.id,
          accessEntry: loadedAccessEntry(savedConfig),
        };
      }

      // Create default configuration for new models
      return { ...getDefaultModelConfig(modelInfo), accessEntry: null };
    });
  }, [modelInfos, savedConfigurations, isLoading, error]);

  return { data: configurations, isLoading: modelInfosPending || isLoading, error, refetch };
}

// Default model configuration logic
export const getDefaultModelConfig = (modelInfo: ModelInfo): LLMModelConfig => {
  // Enabled by default unless the model is private, or blocked by an operator
  // (`disabled`) or by discovery (`autoDisabled`, which toModelInfo folds into the
  // same flag). Defaulting a blocked model to enabled would undo the block for
  // every model that has no saved config yet.
  const isEnabled = !modelInfo.private && !modelInfo.disabled;

  // All users get access to all models by default - no cost-based restrictions.
  // Expressed as the reserved `base` entitlement (held by every authenticated
  // user) rather than a proxy tag set, so a tag-less account still sees the
  // model. `isModelAccessible` stays fail-closed for a genuinely ungated config
  // (empty tags AND empty entitlements); admins narrow access by setting tags /
  // entitlements, or hide a model outright with `enabled: false`.
  return {
    ...modelInfo,
    enabled: isEnabled,
    allowedUserTags: [],
    allowedEntitlements: [BASE_ENTITLEMENT_KEY],
    fallbackModel: '',
  };
};
