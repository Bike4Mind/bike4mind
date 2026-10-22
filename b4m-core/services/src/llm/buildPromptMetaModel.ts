import { isPromptMetaModelType, type ModelInfo } from '@bike4mind/common';

/** promptMeta.model fields for a resolved model, minus request parameters. An unsupported type is recorded as undefined; callers that must reject it validate first. */
export function buildPromptMetaModel(modelInfo: ModelInfo) {
  return {
    name: modelInfo.id,
    type: isPromptMetaModelType(modelInfo.type) ? modelInfo.type : undefined,
    backend: modelInfo.backend,
    contextWindow: modelInfo.contextWindow,
    maxTokens: modelInfo.max_tokens,
    canStream: modelInfo.can_stream,
    canThink: modelInfo.can_think,
    supportsVision: modelInfo.supportsVision,
    supportsTools: modelInfo.supportsTools,
    supportsImageVariation: modelInfo.supportsImageVariation,
    supportsSafetyTolerance: modelInfo.supportsSafetyTolerance,
    trainingCutoff: modelInfo.trainingCutoff,
  };
}
