import type { ModelInfo } from '@bike4mind/common';

/**
 * Which catalog models agent-ops may generate with. Shared by the AgentOpsTab picker and the
 * agent-ops-settings endpoint's save validation so the two cannot offer and reject the same
 * model -- they previously kept separate hand-maintained lists and drifted apart.
 *
 * Both sides read the same catalog: the picker through /api/models (useModelInfo), the endpoint
 * through getAvailableModels. Deprecated and private models are already filtered out upstream.
 */

/** Text models, best-first. Includes `disabled` ones so the picker can explain their absence. */
export function agentOpsModelOptions(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter(m => m.type === 'text')
    .sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)
    );
}

/**
 * Why an admin may not newly pin `modelId`, or null when they may. A disabled model is listed
 * by the picker but not saveable, and its own `disabledReason` is what gets surfaced -- matching
 * how ModelSelection and ChatCompletionInvoke report the same refusal.
 */
export function agentOpsModelRejection(models: ModelInfo[], modelId: string): string | null {
  const model = models.find(m => m.type === 'text' && m.id === modelId);
  if (!model) return 'Invalid LLM model specified';
  if (model.disabled) return model.disabledReason || `${model.name} is not available`;
  return null;
}

/** Whether an admin may newly pin `modelId`. Disabled models are listed but not saveable. */
export function isSelectableAgentOpsModel(models: ModelInfo[], modelId: string): boolean {
  return agentOpsModelRejection(models, modelId) === null;
}
