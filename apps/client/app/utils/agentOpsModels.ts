import { ModelBackend, type ModelInfo } from '@bike4mind/common';

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

const BACKEND_LABELS: Partial<Record<ModelBackend, string>> = {
  [ModelBackend.OpenAI]: 'OpenAI',
  [ModelBackend.Bedrock]: 'Bedrock',
  [ModelBackend.Anthropic]: 'Anthropic',
  [ModelBackend.Gemini]: 'Gemini',
  [ModelBackend.Ollama]: 'Ollama',
  [ModelBackend.XAI]: 'xAI',
  [ModelBackend.Kimi]: 'Kimi',
  [ModelBackend.VoyageAI]: 'Voyage AI',
  [ModelBackend.AWS]: 'AWS',
  [ModelBackend.BFL]: 'BFL',
  [ModelBackend.LocalImage]: 'Local',
};

const backendLabel = (backend: ModelBackend): string => BACKEND_LABELS[backend] ?? backend;

/**
 * Display label per model id, disambiguating names shared across backends. Two catalog models can
 * carry the same `name` -- the direct-provider and Bedrock twins of "Claude 4 Opus" -- yet route to
 * different credentials, and the picker rendered only the name, so an admin had no way to tell them
 * apart and a wrong pick billed the unintended account (#1596). A name used by more than one option
 * gets a `(Backend)` suffix on every twin; if the backend does not break the tie either, the model
 * id is appended so every option stays distinguishable.
 */
export function agentOpsModelLabels(models: ModelInfo[]): Map<string, string> {
  const byName = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const group = byName.get(m.name);
    if (group) group.push(m);
    else byName.set(m.name, [m]);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      for (const m of group) labels.set(m.id, name);
      continue;
    }
    const backendCounts = new Map<ModelBackend, number>();
    for (const m of group) backendCounts.set(m.backend, (backendCounts.get(m.backend) ?? 0) + 1);
    for (const m of group) {
      const suffix =
        (backendCounts.get(m.backend) ?? 0) > 1 ? `${backendLabel(m.backend)}: ${m.id}` : backendLabel(m.backend);
      labels.set(m.id, `${name} (${suffix})`);
    }
  }
  return labels;
}
