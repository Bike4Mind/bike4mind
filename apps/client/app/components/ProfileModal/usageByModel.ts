import { normalizeModelsDevKey, resolveModelName, ModelBackend, type ModelInfo } from '@bike4mind/common';

// Bedrock ids lead with the model vendor (`anthropic.claude-sonnet-5-5`), which the first-party API id omits.
const BEDROCK_VENDOR_PREFIX =
  /^(anthropic|amazon|meta|mistral|deepseek|moonshotai|moonshot|openai|google|cohere|ai21)\./;

/**
 * One key per model across backends. Credit rows record whichever id served the call, so the same
 * model arrives as `claude-sonnet-5-5` (Anthropic API) and `global.anthropic.claude-sonnet-5-5`
 * (Bedrock inference profile); region prefix, vendor prefix, version and date all drop out.
 */
export const usageModelKey = (id: string): string => normalizeModelsDevKey(id).replace(BEDROCK_VENDOR_PREFIX, '');

/** Usage credits summed per model, labelled with the picker's display name when the id is known. */
export function aggregateUsageByModel(
  transactions: readonly { metadata?: Record<string, unknown>; model?: unknown; credits: number }[],
  models: readonly ModelInfo[]
): Record<string, number> {
  const nameByKey = new Map<string, string>();
  // First-party names win over the Bedrock rows, whose names carry the hosting detail.
  for (const model of [...models].sort(
    (a, b) => Number(a.backend === ModelBackend.Bedrock) - Number(b.backend === ModelBackend.Bedrock)
  )) {
    const key = usageModelKey(model.id);
    if (!nameByKey.has(key)) nameByKey.set(key, model.name);
  }

  const labelByKey = new Map<string, string>();
  const usage: Record<string, number> = {};
  for (const transaction of transactions) {
    const rawId = resolveModelName(transaction);
    const key = usageModelKey(rawId);
    const label = labelByKey.get(key) ?? nameByKey.get(key) ?? rawId;
    labelByKey.set(key, label);
    usage[label] = (usage[label] ?? 0) + Math.abs(transaction.credits);
  }
  return usage;
}
