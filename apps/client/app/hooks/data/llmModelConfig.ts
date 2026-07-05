import { api } from '@client/app/contexts/ApiContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMemo } from 'react';
import { LLMModelConfig, ModelInfo, PREDEFINED_USER_TAGS } from '@bike4mind/common';

/**
 * Hook to fetch LLM model configurations from admin settings
 */
export function useLLMModelConfigurations() {
  return useQuery({
    queryKey: ['llm-model-configurations'],
    queryFn: async () => {
      try {
        const response = await api.get<{ settingValue: LLMModelConfig[] }>(`/api/admin/llm-models/configurations`);
        return response.data?.settingValue || [];
      } catch (error) {
        // If setting doesn't exist yet, return empty array
        return [];
      }
    },
    staleTime: 1000 * 30, // 30 seconds - reduced from 5 minutes for quicker updates
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}

/**
 * Hook to save LLM model configurations to admin settings
 */
export function useSaveLLMModelConfigurations(onSuccessCallback?: () => void) {
  const queryClient = useQueryClient();
  const { refetch: refetchAdminSettings } = useAdminSettings();

  return useMutation({
    mutationFn: async (configurations: LLMModelConfig[]) => {
      const { data } = await api.put(`/api/admin/llm-models/configurations`, {
        configurations,
      });
      return data;
    },
    onSuccess: async () => {
      // Force immediate refetch of configurations
      queryClient.invalidateQueries({ queryKey: ['llm-model-configurations'] });
      queryClient.refetchQueries({ queryKey: ['llm-model-configurations'] });
      queryClient.invalidateQueries({ queryKey: ['adminsettings'] });

      // Also refetch AdminSettingsContext to ensure UI updates immediately
      try {
        await refetchAdminSettings();
      } catch (error) {
        console.warn('Failed to refetch admin settings context:', error);
      }

      toast.success('LLM model configurations saved successfully');
      onSuccessCallback?.();
    },
    onError: (error: any) => {
      console.log(JSON.stringify(error, null, 2));
      toast.error(`Failed to save configurations: ${error?.message || 'Unknown error'}`);
    },
  });
}

/**
 * Hook that combines fetching current configurations with model info to create initial configs
 */
export function useLLMModelConfigurationsWithDefaults(modelInfos?: ModelInfo[]) {
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

  return { data: configurations, isLoading: !modelInfos || isLoading };
}

// Default model configuration logic
const getDefaultModelConfig = (modelInfo: ModelInfo): LLMModelConfig => {
  // Enabled by default unless the model is private
  const isEnabled = !modelInfo.private;

  // All users get access to all models by default - no cost-based restrictions.
  // Admin can still override per-model access via the LLM config panel if needed.
  const defaultTags = PREDEFINED_USER_TAGS.map(tag => tag.toLowerCase());

  return {
    ...modelInfo,
    enabled: isEnabled,
    allowedUserTags: defaultTags,
    fallbackModel: '',
  };
};
