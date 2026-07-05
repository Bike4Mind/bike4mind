import { LLMModelConfig } from '@bike4mind/common';
import { isModelAccessible } from '@bike4mind/utils';

// `entitlementKeys` defaults to empty (tag-only matching) so the accessibility
// check stays in lockstep with the entitlement-aware `isModelAccessible`
// without changing behavior for callers that don't resolve entitlements.
export function getFallbackModel(
  modelId: string,
  modelConfigurations: LLMModelConfig[],
  userTags: string[],
  entitlementKeys: string[] = []
): LLMModelConfig | null {
  const model = modelConfigurations?.find(m => m.id === modelId);
  if (!model?.fallbackModel) return null;

  const fallbackModel = modelConfigurations?.find(m => m.id === model.fallbackModel);
  if (!fallbackModel) return null;

  return isModelAccessible(fallbackModel, userTags, false, entitlementKeys) ? fallbackModel : null;
}
