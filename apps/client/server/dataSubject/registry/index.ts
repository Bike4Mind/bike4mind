import { premiumDataSubjectRegistries } from '@server/premium-generated/premiumDataSubjectRegistry.generated';
import { CONTRIBUTED_DATA_HOLDER_KINDS } from '../types';
import type { ContributedDataHolderRegistry, DataHolderRegistry } from '../types';
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

export function mergeRegistries(registries: readonly DataHolderRegistry[]): DataHolderRegistry {
  const merged: Record<string, DataHolderRegistry[string]> = {};
  for (const registry of registries) {
    for (const [modelName, holder] of Object.entries(registry)) {
      // A spread would let the later domain silently win; two classifications of one model is a bug.
      if (Object.hasOwn(merged, modelName)) throw new Error(`Data holder "${modelName}" is classified twice`);
      merged[modelName] = holder;
    }
  }
  return merged;
}

/** Rejects what a JS overlay can get past the types: a core-only kind, or a hook name core never resolved. */
export function assertContributedRegistry(registry: ContributedDataHolderRegistry): DataHolderRegistry {
  for (const [modelName, holder] of Object.entries(registry)) {
    const kind: string = holder.kind;
    if (!(CONTRIBUTED_DATA_HOLDER_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Contributed data holder "${modelName}" has kind "${kind}", which an overlay may not use`);
    }
    if ('beforeErasure' in holder) {
      throw new Error(`Contributed data holder "${modelName}" may not declare beforeErasure`);
    }
  }
  return registry;
}

/**
 * Keyed by Mongoose model name (`mongoose.modelNames()`), not collection name. Importing the
 * contributed registry also registers the overlays' models, so every process that loads this module
 * has them before it classifies.
 */
export const DATA_HOLDER_REGISTRY: DataHolderRegistry = mergeRegistries([
  ...DOMAIN_REGISTRIES,
  ...premiumDataSubjectRegistries.map(assertContributedRegistry),
]);

/**
 * Models registered in this process that the registry does not classify. Some models register only
 * when an optional package is installed at deploy time, which this repo's coverage test cannot see,
 * so a caller that walks the registry to export or erase must assert this is empty at runtime
 * rather than silently skip a collection.
 */
export function findUnclassifiedModels(modelNames: readonly string[]): string[] {
  return modelNames.filter(name => !Object.hasOwn(DATA_HOLDER_REGISTRY, name));
}
