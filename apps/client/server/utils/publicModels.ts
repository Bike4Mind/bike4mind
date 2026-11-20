import { toPublicModel, type ModelInfo, type PublicModel } from '@bike4mind/common';
import { reasoningEffortsFor, reasonsWithinOutputBudget } from '@bike4mind/llm-adapters';

/**
 * The models a public endpoint may offer, out of the caller's list (getCallerModelList).
 * Filtered here, not in getCallerModelList: the picker shares that list and keeps a disabled model
 * when it is the caller's active selection. Speech-to-text models (aws transcribe) are not servable
 * by completions or image generation.
 *
 * Shared by GET /api/v1/models and GET /api/v1/client-config so the two never disagree.
 */
export const callablePublicModels = (models: readonly ModelInfo[]): ModelInfo[] =>
  models.filter(model => !model.disabled && model.type !== 'speech-to-text');

/** `toPublicModel` plus the reasoning fields, computed here because `@bike4mind/common` cannot import llm-adapters. */
export const toPublicModelWithReasoning = (model: ModelInfo): PublicModel =>
  toPublicModel(model, {
    reasonsWithinOutputBudget: reasonsWithinOutputBudget(model),
    reasoningEfforts: reasoningEffortsFor(model),
  });
