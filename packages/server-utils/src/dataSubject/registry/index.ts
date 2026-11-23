import { premiumDataSubjectRegistries } from '../../premium-generated/premiumDataSubjectRegistry.generated';
import { CONTRIBUTED_DATA_HOLDER_KINDS } from '../types';
import type { ContributedDataHolderRegistry, DataHolderRegistry } from '../types';
import { assertEntryStructure } from '../registryStructure';
import { aiHolders } from './ai';
import { analyticsHolders } from './analytics';
import { authHolders } from './auth';
import { billingHolders } from './billing';
import { contentHolders } from './content';
import { hearthHolders } from './hearth';
import { infraHolders } from './infra';
import { socialHolders } from './social';

// One file per `@bike4mind/database` model domain. A model registered outside that package is
// classified with its domain, and that domain file imports the module that registers it:
// `Subscription` and `UserSubscription` in `billing.ts`, the four CoreTutorial models in `content.ts`.
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

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// structuredClone would strip an ObjectId to a plain object, so values are copied by hand: plain
// objects and arrays recurse, BSON values are kept as they are, anything else cannot be a registry value.
function cloneEntry(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`cannot hold a ${typeof value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneEntry);
  if (ArrayBuffer.isView(value)) return structuredClone(value);
  if (value instanceof Date) return new Date(value);
  if ('_bsontype' in value) return value;
  if (!isPlainObject(value)) throw new TypeError(`cannot hold a ${value.constructor?.name ?? 'non-plain'} value`);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneEntry(child)]));
}

// Only plain objects and arrays are frozen; a buffer or typed array cannot be frozen with elements.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && (Array.isArray(value) || isPlainObject(value))) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export type ContributedMerge = {
  registry: DataHolderRegistry;
  /** Contributed model names that entered `registry`. */
  accepted: string[];
  /** Problems found while merging; reported on first use, not thrown at load. */
  problems: string[];
};

/**
 * Merges the contributed registries into `core` without throwing. An entry a JS overlay got past
 * the types (a core-only kind, a hook name, a collision) is recorded and left out, so the core
 * entry or the first contribution wins. Accepted entries are deep copies, deep frozen where plain.
 */
export function mergeContributed(
  core: DataHolderRegistry,
  contributed: readonly ContributedDataHolderRegistry[]
): ContributedMerge {
  const registry: Record<string, DataHolderRegistry[string]> = { ...core };
  const accepted: string[] = [];
  const problems: string[] = [];
  const sources: unknown = contributed;
  if (!Array.isArray(sources)) {
    problems.push('Contributed data holder registries are not an array');
    return { registry, accepted, problems };
  }
  for (const source of sources as unknown[]) {
    if (source === null || typeof source !== 'object') {
      problems.push('A contributed data holder registry is not an object');
      continue;
    }
    for (const [modelName, holder] of Object.entries(source)) {
      try {
        const kind: string = (holder as { kind: string }).kind;
        if (Object.hasOwn(registry, modelName)) {
          problems.push(`Data holder "${modelName}" is classified twice`);
        } else if (!(CONTRIBUTED_DATA_HOLDER_KINDS as readonly string[]).includes(kind)) {
          problems.push(`Contributed data holder "${modelName}" has kind "${kind}", which an overlay may not use`);
        } else if ('beforeErasure' in holder) {
          problems.push(`Contributed data holder "${modelName}" may not declare beforeErasure`);
        } else {
          registry[modelName] = deepFreeze(cloneEntry(holder) as DataHolderRegistry[string]);
          accepted.push(modelName);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        problems.push(`Contributed data holder "${modelName}" is malformed: ${reason}`);
      }
    }
  }
  return { registry, accepted, problems };
}

const CORE_REGISTRY = mergeRegistries(DOMAIN_REGISTRIES);
const CONTRIBUTED = mergeContributed(CORE_REGISTRY, premiumDataSubjectRegistries);

/** Keyed by Mongoose model name (`mongoose.modelNames()`), not collection name. */
export const DATA_HOLDER_REGISTRY: DataHolderRegistry = CONTRIBUTED.registry;

let contributedValid = false;

/**
 * Throws one error listing every problem with a contributed entry. Validation waits for first use
 * because a parent model may register after this module loads, and a bad contribution must not
 * take down a process that never erases or exports. Success is cached; a failure is re-checked.
 */
export function assertContributedRegistryValid(): void {
  if (contributedValid) return;
  const problems = [...CONTRIBUTED.problems];
  for (const modelName of CONTRIBUTED.accepted) {
    try {
      assertEntryStructure(modelName, DATA_HOLDER_REGISTRY);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) {
    throw new Error(`Contributed data holder registry is invalid:\n- ${problems.join('\n- ')}`);
  }
  contributedValid = true;
}

/**
 * Models registered in this process that the registry does not classify. Some models register only
 * when an optional package is installed at deploy time, which this repo's coverage test cannot see,
 * so a caller that walks the registry to export or erase must assert this is empty at runtime
 * rather than silently skip a collection.
 */
export function findUnclassifiedModels(modelNames: readonly string[]): string[] {
  return modelNames.filter(name => !Object.hasOwn(DATA_HOLDER_REGISTRY, name));
}
