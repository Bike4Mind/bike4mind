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

/**
 * Usage credits summed per model, labelled with the picker's display name when the id is known.
 * A key that two differently named models normalize to (`claude-3-5-sonnet-20240620-v1:0` and its
 * `-20241022-v2:0` successor) is not one model, so its rows are labelled by exact id instead.
 */
export function aggregateUsageByModel(
  transactions: readonly { metadata?: Record<string, unknown>; model?: unknown; credits: number }[],
  models: readonly ModelInfo[]
): Record<string, number> {
  const nameById = new Map<string, string>();
  // Per key, distinct names (case-insensitive) by tier. First-party names win over the Bedrock
  // rows, whose names carry the hosting detail.
  const namesByKey = new Map<string, { firstParty: Map<string, string>; bedrock: Map<string, string> }>();
  for (const model of models) {
    if (!nameById.has(model.id)) nameById.set(model.id, model.name);
    const key = usageModelKey(model.id);
    const names = namesByKey.get(key) ?? { firstParty: new Map(), bedrock: new Map() };
    const tier = model.backend === ModelBackend.Bedrock ? names.bedrock : names.firstParty;
    if (!tier.has(model.name.toLowerCase())) tier.set(model.name.toLowerCase(), model.name);
    namesByKey.set(key, names);
  }

  const labelByKey = new Map<string, string>();
  const usage: Record<string, number> = {};
  for (const transaction of transactions) {
    const rawId = resolveModelName(transaction);
    const key = usageModelKey(rawId);
    const tiers = namesByKey.get(key);
    const names = tiers && [...(tiers.firstParty.size > 0 ? tiers.firstParty : tiers.bedrock).values()];
    let label: string;
    if (names && names.length > 1) {
      label = nameById.get(rawId) ?? rawId;
    } else {
      label = labelByKey.get(key) ?? names?.[0] ?? rawId;
      labelByKey.set(key, label);
    }
    usage[label] = (usage[label] ?? 0) + Math.abs(transaction.credits);
  }
  return usage;
}
