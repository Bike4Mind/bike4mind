import { normalizeModelsDevKey, resolveModelName, ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { PremiumToolDisplayLabels } from '@client/app/premiumContract';
import { findToolDisplayLabel, humanizeToolId } from '@client/app/utils/toolMapping';

// Bedrock ids lead with the model vendor (`anthropic.claude-sonnet-5-5`), which the first-party API id omits.
const BEDROCK_VENDOR_PREFIX =
  /^(anthropic|amazon|meta|mistral|deepseek|moonshotai|moonshot|openai|google|cohere|ai21)\./;

/**
 * One key per model across backends. Credit rows record whichever id served the call, so the same
 * model arrives as `claude-sonnet-5-5` (Anthropic API) and `global.anthropic.claude-sonnet-5-5`
 * (Bedrock inference profile); region prefix, vendor prefix, version and date all drop out.
 */
export const usageModelKey = (id: string): string => normalizeModelsDevKey(id).replace(BEDROCK_VENDOR_PREFIX, '');

// Rows of these types carry a feature id, not a model id, in the model field.
const APP_CHARGE_TYPES: ReadonlySet<string> = new Set(['tool_usage', 'generic_deduct']);

/** Label for a row with no model id at all. */
export const OTHER_CHARGES_LABEL = 'Other charges';

function featureLabel(type: string | undefined, rawId: string, overlayLabels?: PremiumToolDisplayLabels): string {
  if (rawId === 'Unknown') return OTHER_CHARGES_LABEL;
  const registered = findToolDisplayLabel(rawId, overlayLabels);
  if (registered) return registered;
  return type && APP_CHARGE_TYPES.has(type) ? humanizeToolId(rawId) : rawId;
}

/**
 * Usage credits summed per model, labelled with the picker's display name when the id is known.
 * An id that is not a model gets its registered tool/overlay label, else a humanized one, so a raw
 * feature id never reaches the chart; an unknown id on a model-usage row stays as the model id.
 * A key that two differently named models normalize to (`claude-3-5-sonnet-20240620-v1:0` and its
 * `-20241022-v2:0` successor) is not one model, so its rows are labelled by exact id instead.
 */
export function aggregateUsageByModel(
  transactions: readonly { type?: string; metadata?: Record<string, unknown>; model?: unknown; credits: number }[],
  models: readonly ModelInfo[],
  overlayLabels?: PremiumToolDisplayLabels
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
      label = labelByKey.get(key) ?? names?.[0] ?? featureLabel(transaction.type, rawId, overlayLabels);
      labelByKey.set(key, label);
    }
    usage[label] = (usage[label] ?? 0) + Math.abs(transaction.credits);
  }
  return usage;
}
