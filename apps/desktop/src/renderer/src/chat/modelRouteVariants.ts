import type { ChatModelOption } from '@shared/chat';
import { isLocalModel } from '@shared/chat';

// Bedrock cross-region inference profiles prefix the foundation-model id with a geography. Must stay
// in sync with BEDROCK_PROFILE_PREFIX in apps/client/app/utils/pickerModelDedupe.ts and
// b4m-core/llm-adapters/src/routeTwinNames.ts.
const BEDROCK_PROFILE_PREFIX = /^(global|us-gov|us|eu|apac|jp|au|ca)\./i;

/**
 * Which rows are one model on one provider: a Bedrock foundation id and its `global.`/`us.`/... profiles
 * share a key. Every other id is its own key, so a dated snapshot and its alias stay apart.
 */
export function routeVariantKey(model: Pick<ChatModelOption, 'id' | 'backend'>): string {
  if (model.backend !== 'bedrock' || isLocalModel(model.id)) return model.id;
  return `bedrock:${model.id.toLowerCase().replace(BEDROCK_PROFILE_PREFIX, '')}`;
}

/** Lower wins. Same order as the web picker's routePreference: global, then a geography, then the bare id. */
function routeRank(model: ChatModelOption): number {
  const id = model.id.toLowerCase();
  if (id.startsWith('global.')) return 0;
  return BEDROCK_PROFILE_PREFIX.test(id) ? 1 : 2;
}

function preference(model: ChatModelOption, activeModelId: string | null): number[] {
  return [model.id === activeModelId ? 0 : 1, model.disabled || model.unavailable ? 1 : 0, routeRank(model)];
}

function isPreferred(candidate: number[], incumbent: number[]): boolean | null {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i]! < incumbent[i]!;
  }
  return null;
}

/**
 * One row per model and provider, in input order. Within a set of route variants the conversation's
 * own model wins, so the picker never shows another id as selected or switches it; then an enabled
 * variant, then the route the web picker prefers, then the lower id.
 */
export function mergeRouteVariants(
  models: readonly ChatModelOption[],
  activeModelId: string | null
): ChatModelOption[] {
  const winners = new Map<string, ChatModelOption>();
  for (const model of models) {
    const key = routeVariantKey(model);
    const incumbent = winners.get(key);
    if (!incumbent) {
      winners.set(key, model);
      continue;
    }
    const better = isPreferred(preference(model, activeModelId), preference(incumbent, activeModelId));
    if (better ?? model.id < incumbent.id) winners.set(key, model);
  }
  const kept = new Set(winners.values());
  return models.filter(model => kept.has(model));
}
