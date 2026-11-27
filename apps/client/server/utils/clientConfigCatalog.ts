import type { ClientConfigPickerModel, ModelInfo } from '@bike4mind/common';
import { toPublicModelWithReasoning } from './publicModels';

export function toClientConfigPickerModel(model: ModelInfo): ClientConfigPickerModel {
  return {
    ...toPublicModelWithReasoning(model),
    max_output_tokens_derived: model.maxOutputTokensDerived,
    thinking_style: model.thinkingStyle,
    thinking_always_on: model.thinkingAlwaysOn,
    openai_reasoning_effort: model.openaiReasoningEffort,
    effort_incompatible_with_tools: model.effortIncompatibleWithTools,
    supports_image_variation: model.supportsImageVariation,
    supports_safety_tolerance: model.supportsSafetyTolerance,
    training_cutoff: model.trainingCutoff,
    release_date: model.releaseDate,
    is_superseded: model.isSuperseded,
    is_slow_model: model.isSlowModel,
    disabled: model.disabled,
    disabled_reason: model.disabledReason,
    access: model.access ? { locked: model.access.locked, reason: model.access.reason } : undefined,
  };
}
