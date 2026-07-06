import { useCallback, useMemo } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useLLMModelConfigurationsWithDefaults } from '@client/app/hooks/data/llmModelConfig';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
// Single source of truth: pure, browser-safe (no AWS SDK), unit-tested in
// @bike4mind/common. Access is any-of: admin OR (allowedUserTags intersect
// userTags) OR (allowedEntitlements intersect entitlementKeys); empty keys
// means tag-only.
import { isModelAccessible } from '@bike4mind/common';

/**
 * Hook that returns only the models that the current user can access
 * based on LLM dashboard configurations and user roles
 */
export function useAccessibleModels() {
  const currentUser = useUser(s => s.currentUser);
  const { data: modelInfos } = useModelInfo();
  const { data: modelConfigs, isLoading: isConfigsLoading } = useLLMModelConfigurationsWithDefaults(modelInfos);
  // Resolved entitlement keys (subscription- + tag-derived). Gates
  // entitlement-scoped models so a tag-less subscriber still gets accessible
  // models (and an enabled send button). A failed/empty fetch yields [] and
  // tag-only matching, so the send path never breaks on entitlement errors.
  const { data: entitlements } = useEntitlements();

  // Stabilize userTags by keying on the serialized tag values, not the object reference.
  // currentUser reference changes on every setCurrentUser call even when tags haven't changed,
  // which would cause isModelAccessible/getFallbackModel to be recreated on every render.
  const tagsKey = currentUser?.tags?.join(',') ?? '';
  const userTags = useMemo(() => currentUser?.tags || [], [tagsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const isAdmin = useMemo(() => currentUser?.isAdmin || false, [currentUser?.isAdmin]);
  // Stabilize entitlementKeys on serialized values for the same reason as userTags.
  const entitlementsKey = entitlements?.join(',') ?? '';
  const entitlementKeys = useMemo(() => entitlements || [], [entitlementsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const accessibleModels = useMemo(() => {
    if (!modelConfigs || modelConfigs.length === 0) {
      return [];
    }

    return modelConfigs.filter(model => isModelAccessible(model, userTags, isAdmin, entitlementKeys));
  }, [modelConfigs, userTags, isAdmin, entitlementKeys]);

  // Also provide helpers for specific model types
  const accessibleTextModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'text');
  }, [accessibleModels]);

  const accessibleImageModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'image');
  }, [accessibleModels]);

  const accessibleSpeechModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'speech-to-text');
  }, [accessibleModels]);

  const accessibleVideoModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'video');
  }, [accessibleModels]);

  return {
    accessibleModels,
    accessibleTextModels,
    accessibleImageModels,
    accessibleSpeechModels,
    accessibleVideoModels,
    // Gate loading on the presence of the user object, not on `tags`. A user
    // can legitimately have no tags (`tags: null` or `[]` - e.g. admin-created
    // without tags), and empty/absent tags are handled by isModelAccessible as
    // tag-only matching. Gating on `!currentUser?.tags` here stuck those users
    // on "Loading AI models..." forever. Once `currentUser` is set we resolve;
    // while it's still null (not yet hydrated) we keep loading.
    isLoading: isConfigsLoading || !currentUser,
    userTags,
    isAdmin,
    isModelAccessible: useCallback(
      (modelId: string) => {
        const model = modelConfigs?.find(m => m.id === modelId);
        return model ? isModelAccessible(model, userTags, isAdmin, entitlementKeys) : false;
      },
      [modelConfigs, userTags, isAdmin, entitlementKeys]
    ),
    getFallbackModel: useCallback(
      (modelId: string) => {
        const model = modelConfigs?.find(m => m.id === modelId);
        if (!model?.fallbackModel) return null;

        const fallbackModel = modelConfigs?.find(m => m.id === model.fallbackModel);
        if (!fallbackModel) return null;

        // Verify fallback model is accessible to the user
        return isModelAccessible(fallbackModel, userTags, isAdmin, entitlementKeys) ? fallbackModel : null;
      },
      [modelConfigs, userTags, isAdmin, entitlementKeys]
    ),
  };
}
