import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { LLMModelConfig, MODEL_ACCESS_REVISION_HEADER, ModelInfo } from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

export const LLM_MODEL_CONFIGURATIONS_QUERY_KEY = ['llm-model-configurations'] as const;

/** The access entries plus the access revision they were read under (modelAccessRevision.ts compares it). */
export type LLMModelConfigurationsData = { configurations: LLMModelConfig[]; revision: string | null };

/** Model access entries. Writes go through the per-model and bulk access endpoints (hooks/data/adminModels.ts). */
export function useLLMModelConfigurations() {
  return useQuery({
    queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY,
    queryFn: async (): Promise<LLMModelConfigurationsData> => {
      try {
        const response = await api.get<{ settingValue: LLMModelConfig[] }>(`/api/admin/llm-models/configurations`);
        const revision = response.headers?.[MODEL_ACCESS_REVISION_HEADER];
        return {
          configurations: response.data?.settingValue || [],
          revision: typeof revision === 'string' && revision.length > 0 ? revision : null,
        };
      } catch (error) {
        // If setting doesn't exist yet, return empty array
        return { configurations: [], revision: null };
      }
    },
    select: (data: LLMModelConfigurationsData) => data.configurations,
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
  const { data: savedConfigurations, isLoading } = useLLMModelConfigurations();

  const configurations = useMemo(() => {
    if (!modelInfos || isLoading) {
      return [];
    }

    // Merge saved configurations with model info, preferring saved configurations
    return modelInfos.map(modelInfo => {
      const savedConfig = savedConfigurations?.find(config => config.id === modelInfo.id);

      if (savedConfig) {
        return {
          ...modelInfo,
          ...savedConfig,
        };
      }

      // Create default configuration for new models
      return getDefaultModelConfig(modelInfo);
    });
  }, [modelInfos, savedConfigurations, isLoading]);

  return { data: configurations, isLoading: modelInfosPending || isLoading };
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
