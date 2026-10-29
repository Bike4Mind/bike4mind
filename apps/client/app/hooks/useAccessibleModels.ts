import { useCallback, useMemo } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useLockedModels, useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useLLMModelConfigurationsWithDefaults } from '@client/app/hooks/data/llmModelConfig';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
// Single source of truth: pure, browser-safe (no AWS SDK), unit-tested in
// @bike4mind/common. Access is any-of: admin OR (allowedUserTags intersect
// userTags) OR (allowedEntitlements intersect entitlementKeys); empty keys
// means tag-only.
import { isModelAccessible, isModelDeprecated, PAID_PLAN_ENTITLEMENT_KEY } from '@bike4mind/common';

/**
 * Hook that returns only the models that the current user can access
 * based on LLM dashboard configurations and user roles
 */
export function useAccessibleModels() {
  const currentUser = useUser(s => s.currentUser);
  const {
    data: modelInfos,
    isPending: isModelInfosPending,
    isError: isModelsError,
    refetch: refetchModelInfos,
  } = useModelInfo();
  const { data: modelConfigs, isLoading: isConfigsLoading } = useLLMModelConfigurationsWithDefaults(
    modelInfos,
    isModelInfosPending
  );
  const { data: lockedInfos, isPending: isLockedInfosPending } = useLockedModels();
  const { data: lockedConfigs } = useLLMModelConfigurationsWithDefaults(lockedInfos, isLockedInfosPending);
  // Resolved entitlement keys (subscription- + tag-derived). Gates
  // entitlement-scoped models so a tag-less subscriber still gets accessible
  // models (and an enabled send button). A failed/empty fetch yields [] and
  // tag-only matching, so the send path never breaks on entitlement errors.
  const { data: entitlements, isLoading: isEntitlementsLoading } = useEntitlements();

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

  // Locked (paid-only) models honor the same admin config, evaluated as if the user held the paid
  // plan, so a model an admin disabled or tag-restricted is not advertised behind an Upgrade CTA.
  // Returns the original ModelInfo entries (with their `access` stamp), not the merged configs.
  const lockedModels = useMemo(() => {
    if (!lockedInfos || lockedConfigs.length === 0) return [];
    const paidKeys = [...entitlementKeys, PAID_PLAN_ENTITLEMENT_KEY];
    const allowedIds = new Set(
      lockedConfigs.filter(config => isModelAccessible(config, userTags, isAdmin, paidKeys)).map(config => config.id)
    );
    return lockedInfos.filter(info => allowedIds.has(info.id));
  }, [lockedInfos, lockedConfigs, userTags, isAdmin, entitlementKeys]);

  // Type-specific lists feed the model pickers, so they also drop retired models
  // (deprecationDate reached). The raw `accessibleModels` is intentionally left
  // unfiltered: it backs validation, default resolution, and fallback, where a
  // session/agent still pinned to a just-retired model must remain recognized.
  const accessibleTextModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'text' && !isModelDeprecated(model));
  }, [accessibleModels]);

  const accessibleImageModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'image' && !isModelDeprecated(model));
  }, [accessibleModels]);

  const accessibleSpeechModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'speech-to-text' && !isModelDeprecated(model));
  }, [accessibleModels]);

  const accessibleVideoModels = useMemo(() => {
    return accessibleModels.filter(model => model.type === 'video' && !isModelDeprecated(model));
  }, [accessibleModels]);

  return {
    accessibleModels,
    accessibleTextModels,
    accessibleImageModels,
    accessibleSpeechModels,
    accessibleVideoModels,
    lockedModels,
    // Gate loading on the presence of the user object, not on `tags`. A user
    // can legitimately have no tags (`tags: null` or `[]` - e.g. admin-created
    // without tags), and empty/absent tags are handled by isModelAccessible as
    // tag-only matching. Gating on `!currentUser?.tags` here stuck those users
    // on "Loading AI models..." forever. Once `currentUser` is set we resolve;
    // while it's still null (not yet hydrated) we keep loading.
    isLoading: isConfigsLoading || !currentUser,
    // Distinguishes a failed /api/models fetch (retryable) from a user with no model access.
    isModelsError,
    // Until the first entitlements fetch settles, models gated by entitlement (including the
    // universal 'base' key) are missing from accessibleModels, so the list is a partial one.
    isEntitlementsLoading,
    refetchModels: refetchModelInfos,
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
