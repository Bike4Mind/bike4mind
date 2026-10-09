import { DECISION_MODEL_CATALOG, DECISION_MODEL_IDS, type DecisionModelId } from '@bike4mind/common';
import type { DecisionProvider } from './types';

export type DecisionProviderRegistry = {
  /** The adapter serving `model`, or undefined when its protocol is not registered (e.g. the test model in prod). */
  forModel(model: DecisionModelId): DecisionProvider | undefined;
  models(): DecisionModelId[];
};

// The catalog is the single owner of model -> protocol, so an adapter must serve exactly the models assigned to it.
const assertModelsMatchCatalog = (provider: DecisionProvider): void => {
  for (const model of provider.models) {
    const owner = DECISION_MODEL_CATALOG[model].protocol;
    if (owner !== provider.id) {
      throw new Error(`decision provider ${provider.id} lists ${model}, which the catalog assigns to ${owner}`);
    }
  }
  const missing = DECISION_MODEL_IDS.filter(
    id => DECISION_MODEL_CATALOG[id].protocol === provider.id && !provider.models.includes(id)
  );
  if (missing.length > 0) {
    throw new Error(`decision provider ${provider.id} does not list catalog models: ${missing.join(', ')}`);
  }
};

export const createDecisionProviderRegistry = (providers: readonly DecisionProvider[]): DecisionProviderRegistry => {
  const byModel = new Map<DecisionModelId, DecisionProvider>();
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`duplicate decision provider: ${provider.id}`);
    seen.add(provider.id);
    assertModelsMatchCatalog(provider);
    for (const model of provider.models) byModel.set(model, provider);
  }
  return { forModel: model => byModel.get(model), models: () => [...byModel.keys()] };
};
