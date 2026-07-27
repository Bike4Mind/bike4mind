/**
 * The aggregator join (spec sec 5.6). Pure, deterministic, and deliberately
 * placed in `common` rather than in the discovery service: the checked-in
 * coverage guard lives in `packages/database` next to the seed it measures, and
 * `packages/database` cannot be imported by `@bike4mind/services`. `common` is
 * the only package both sides already depend on.
 *
 * Getting this wrong is a quiet Goal-1 failure: under `modelDiscoveryAutoEnable:
 * 'priced'` an id that fails to join has no price, so it lands disabled and
 * nobody learns why. Hence: measured, not assumed.
 */

/** The two aggregators the catalog joins against. Each gets its own normalizer. */
export type AggregatorName = 'modelsDev' | 'litellm';

/**
 * One row of the checked-in override map (`packages/database/src/seeds/modelIdAliases.json`),
 * keyed by OUR model id. An entry always beats the normalizer.
 */
export interface ModelIdAliasEntry {
  modelsDev?: string;
  litellm?: string;
}

export type ModelIdAliasMap = Readonly<Record<string, ModelIdAliasEntry>>;

/**
 * Routing prefixes Bedrock puts in front of a model id. Exactly the four the
 * spec names; other regions exist in aggregator key space (`jp.`, `au.`) but our
 * ids never use them, so leaving those keys unstripped costs a duplicate index
 * entry and never a wrong match.
 */
const REGION_PREFIXES = ['us.', 'eu.', 'apac.', 'global.'] as const;

/**
 * Bedrock version suffix. Widened from the spec's literal `-v1:0` / `-v2:0` to
 * the `-v1` form both aggregators also publish (`anthropic.claude-opus-4-6-v1`);
 * stripping only the `:0` spelling would leave those permanently unjoined.
 */
const VERSION_SUFFIX = /-v\d+(?::\d+)?$/;

/** Trailing ISO date, in the two spellings provider ids use. */
const DATE_SUFFIX_COMPACT = /-\d{8}$/;
const DATE_SUFFIX_DASHED = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Namespaces whose `<ns>/` prefix is collapsed. First-party only, on purpose:
 * collapsing a gateway prefix would let `azure_ai/gpt-5.5` or
 * `openrouter/openai/gpt-5.5` outrank the real `gpt-5.5` entry and hand us a
 * resold price for a direct call. An unlisted prefix is left in place, which
 * keeps that key in the index under a name nothing of ours can collide with.
 */
const MODELS_DEV_NAMESPACES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'gemini',
  'xai',
  'bedrock',
  'amazon-bedrock',
]);

const LITELLM_NAMESPACES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'bedrock',
  'ollama',
  'elevenlabs',
  'voyage',
  'black_forest_labs',
]);

/**
 * models.dev is keyed `{provider: {models: {id: ...}}}`; only these providers are
 * indexed. Indexing all 172 would put 5,755 bare ids in one namespace, where a
 * reseller's `glm-4` can shadow the model we actually call.
 *
 * MUST STAY IN SYNC WITH ModelBackend: a backend absent here simply never joins
 * models.dev, which shows up as coverage rather than as a wrong price.
 */
export const MODELS_DEV_PROVIDER_BY_BACKEND: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  xai: 'xai',
  bedrock: 'amazon-bedrock',
};

function namespacesFor(aggregator: AggregatorName): ReadonlySet<string> {
  return aggregator === 'modelsDev' ? MODELS_DEV_NAMESPACES : LITELLM_NAMESPACES;
}

/**
 * The normalizer, in the fixed order the spec sets: lowercase, collapse the
 * provider-qualified form, strip the regional prefix, strip the Bedrock version
 * suffix, strip a trailing ISO date.
 */
function normalize(key: string, namespaces: ReadonlySet<string>): string {
  let value = key.trim().toLowerCase();

  // Loop rather than a single split: litellm nests (`openrouter/openai/gpt-5`),
  // and the loop stops at the first prefix that is not first-party.
  while (value.includes('/')) {
    const slash = value.indexOf('/');
    if (!namespaces.has(value.slice(0, slash))) break;
    value = value.slice(slash + 1);
  }

  for (const prefix of REGION_PREFIXES) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  value = value.replace(VERSION_SUFFIX, '');
  value = value.replace(DATE_SUFFIX_COMPACT, '');
  value = value.replace(DATE_SUFFIX_DASHED, '');
  return value;
}

export const normalizeModelsDevKey = (key: string): string => normalize(key, MODELS_DEV_NAMESPACES);

export const normalizeLiteLlmKey = (key: string): string => normalize(key, LITELLM_NAMESPACES);

export function normalizeAggregatorKey(key: string, aggregator: AggregatorName): string {
  return normalize(key, namespacesFor(aggregator));
}

/**
 * An aggregator's key space, prepared for lookup. `byExact` exists so a dated id
 * that the aggregator also publishes dated resolves to itself rather than to the
 * undated sibling both normalize to.
 */
export interface AggregatorKeyIndex {
  aggregator: AggregatorName;
  byExact: ReadonlyMap<string, string>;
  byNormalized: ReadonlyMap<string, string>;
}

/**
 * Collisions are the norm (`claude-opus-4-5` and `claude-opus-4-5-20251101`
 * normalize alike), so the winner is pinned: shortest original key, ties broken
 * lexicographically. Shortest is the undated, unregioned, canonical spelling,
 * and pinning it is what keeps a run reproducible when the aggregator reorders
 * its JSON.
 */
export function buildAggregatorKeyIndex(keys: Iterable<string>, aggregator: AggregatorName): AggregatorKeyIndex {
  const namespaces = namespacesFor(aggregator);
  const byExact = new Map<string, string>();
  const byNormalized = new Map<string, string>();

  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) continue;
    byExact.set(key, key);
    const normalized = normalize(key, namespaces);
    const held = byNormalized.get(normalized);
    if (held === undefined || key.length < held.length || (key.length === held.length && key < held)) {
      byNormalized.set(normalized, key);
    }
  }

  return { aggregator, byExact, byNormalized };
}

export interface AggregatorMatch {
  /** The aggregator's own key for this model. */
  key: string;
  how: 'alias' | 'exact' | 'normalized';
}

/**
 * Resolve one of our model ids to an aggregator key: alias first (an entry
 * always beats the normalizer), then an exact key, then the normalized form.
 *
 * A dead alias - one naming a key the aggregator does not publish - resolves to
 * null rather than silently falling through to the normalizer. Falling through
 * would hide the stale entry forever; the seed test fails the build on it.
 */
export function resolveAggregatorKey(
  modelId: string,
  index: AggregatorKeyIndex,
  aliases?: ModelIdAliasMap
): AggregatorMatch | null {
  const alias = aliases?.[modelId]?.[index.aggregator];
  if (alias !== undefined) {
    return index.byExact.has(alias) ? { key: alias, how: 'alias' } : null;
  }

  const exact = index.byExact.get(modelId);
  if (exact !== undefined) return { key: exact, how: 'exact' };

  const normalized = index.byNormalized.get(normalize(modelId, namespacesFor(index.aggregator)));
  return normalized === undefined ? null : { key: normalized, how: 'normalized' };
}

/** matched / total over a set of our ids, the AggregatorJoinCoverage numerator and denominator. */
export function measureJoinCoverage(
  modelIds: Iterable<string>,
  index: AggregatorKeyIndex,
  aliases?: ModelIdAliasMap
): { matched: number; total: number; unmatched: string[] } {
  const unmatched: string[] = [];
  let matched = 0;
  let total = 0;
  for (const modelId of modelIds) {
    total += 1;
    if (resolveAggregatorKey(modelId, index, aliases)) matched += 1;
    else unmatched.push(modelId);
  }
  return { matched, total, unmatched: unmatched.sort() };
}
