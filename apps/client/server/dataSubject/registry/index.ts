import type { DataHolderRegistry } from '../types';
import { aiHolders } from './ai';
import { analyticsHolders } from './analytics';
import { authHolders } from './auth';
import { billingHolders } from './billing';
import { contentHolders } from './content';
import { hearthHolders } from './hearth';
import { infraHolders } from './infra';
import { socialHolders } from './social';

// One file per `@bike4mind/database` model domain, plus billing's two models registered outside
// that package (`Subscription`, `UserSubscription`), which live in `billing.ts`.
const DOMAIN_REGISTRIES: readonly DataHolderRegistry[] = [
  aiHolders,
  analyticsHolders,
  authHolders,
  billingHolders,
  contentHolders,
  hearthHolders,
  infraHolders,
  socialHolders,
];

function mergeRegistries(registries: readonly DataHolderRegistry[]): DataHolderRegistry {
  const merged: Record<string, DataHolderRegistry[string]> = {};
  for (const registry of registries) {
    for (const [modelName, holder] of Object.entries(registry)) {
      // A spread would let the later domain silently win; two classifications of one model is a bug.
      if (modelName in merged) throw new Error(`Data holder "${modelName}" is classified twice`);
      merged[modelName] = holder;
    }
  }
  return merged;
}

/** Keyed by Mongoose model name (`mongoose.modelNames()`), not collection name. */
export const DATA_HOLDER_REGISTRY: DataHolderRegistry = mergeRegistries(DOMAIN_REGISTRIES);

/**
 * Models registered in this process that the registry does not classify. Some models register only
 * when an optional package is installed at deploy time, which this repo's coverage test cannot see,
 * so a caller that walks the registry to export or erase must assert this is empty at runtime
 * rather than silently skip a collection.
 */
export function findUnclassifiedModels(modelNames: readonly string[]): string[] {
  return modelNames.filter(name => !(name in DATA_HOLDER_REGISTRY));
}
