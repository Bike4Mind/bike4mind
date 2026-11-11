import { claudeFamilyVersion } from './claudeModelId';
import { ModelBackend, REFUSAL_FALLBACK_MODELS } from './models';
import type { ModelInfo } from './models';
import { API_SURFACE_KEYS } from './types/entities/ModelCatalogTypes';
import type { AdapterFamily, ApiSurface } from './types/entities/ModelCatalogTypes';

/**
 * Seed tier of the catalog's `apiSurface` group: the per-model request features this build shipped
 * as id tables before the catalog carried them. resolveApiSurface consults them only when no catalog
 * row states a value, and only for the ids they name; a model they do not name gets the default below.
 * Sources: the tool search tool and mid-conversation system messages pages of the Claude docs.
 */
const TOOL_SEARCH_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-5',
  'opus-4-6',
  'opus-4-7',
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-4-5',
  'sonnet-4-6',
  'sonnet-5',
  'sonnet-5-5',
  'haiku-4-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

// Sonnet 5 is left out on purpose: it takes no mid-conversation system messages.
const TOOL_CHANGES_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-5-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

const NO_ASSISTANT_PREFILL_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-6',
  'opus-4-7',
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-4-6',
  'sonnet-5',
  'sonnet-5-5',
  'haiku-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

// By-reference tool changes per platform. Haiku 5.5 takes them on the Claude API (verified with a live
// request) but Bedrock documents it as by-value only. Bedrock lists no Sonnet 5.5 either.
const DEFERRED_ADDITION_ANTHROPIC_VERSIONS: ReadonlySet<string> = new Set([
  'haiku-5-5',
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'sonnet-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);
const DEFERRED_ADDITION_BEDROCK_VERSIONS: ReadonlySet<string> = new Set([
  'opus-4-8',
  'opus-5',
  'opus-5-5',
  'fable-5',
  'fable-5-1',
  'mythos-5',
  'mythos-5-1',
]);

/**
 * Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 return 400 for `tool_choice` `{type:'any'}` and
 * `{type:'tool'}` (Messages, count_tokens and Batches alike). Matches the native, Bedrock (any region
 * prefix), gateway (`anthropic/`), context-suffixed (`[1m]`) and patch-version spellings alike: an
 * unreviewed spelling of these models must still read as unsupported. Haiku 5.5 is deliberately absent:
 * it accepts forced `any`/`tool` (raw Bedrock API probe, adaptive thinking on; native API: forced `tool`
 * observed via json_schema, forced `any` not probed) and its response just carries no thinking block.
 */
const NO_FORCED_TOOL_CHOICE_FAMILY = /(?:^|[./])claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(?=$|[-:@[])/;

const SEEDED_VERSIONS: ReadonlySet<string> = new Set([
  ...TOOL_SEARCH_VERSIONS,
  ...TOOL_CHANGES_VERSIONS,
  ...NO_ASSISTANT_PREFILL_VERSIONS,
  ...DEFERRED_ADDITION_ANTHROPIC_VERSIONS,
  ...DEFERRED_ADDITION_BEDROCK_VERSIONS,
]);

export type ClaudeToolCapabilityModel = {
  id: string;
  backend: ModelBackend;
};

export type CompletionsToolCapabilityModel = ClaudeToolCapabilityModel & {
  adapterFamily?: AdapterFamily;
};

/** What resolveApiSurface reads: a ModelInfo, or as much of one as the caller has. */
export type ApiSurfaceModel = Pick<ClaudeToolCapabilityModel, 'id'> &
  Partial<Pick<CompletionsToolCapabilityModel, 'backend' | 'adapterFamily'>> &
  Partial<Pick<ModelInfo, 'thinkingStyle'>> &
  Partial<ApiSurface>;

type RoutedApiSurfaceModel = ApiSurfaceModel & ClaudeToolCapabilityModel;

// Mirror getLlmByModel's dispatch: a catalog row routes on adapterFamily first, everything else on backend.
// MUST STAY IN SYNC WITH getLlmByModel (llm-adapters/src/index.ts) and backendForAdapterFamily
// (llm-adapters/src/adapterFamilyDispatch.ts).
function servedByDirectAnthropic(model: Pick<ApiSurfaceModel, 'backend' | 'adapterFamily'>): boolean {
  return model.adapterFamily ? model.adapterFamily === 'anthropic-messages' : model.backend === ModelBackend.Anthropic;
}

// Both Claude adapters forward defer_loading and server tools and replay server blocks.
function servedByClaudeAdapter(model: Pick<ApiSurfaceModel, 'backend' | 'adapterFamily'>): boolean {
  if (servedByDirectAnthropic(model)) return true;
  return model.adapterFamily ? model.adapterFamily === 'bedrock-anthropic' : model.backend === ModelBackend.Bedrock;
}

// The direct API and Bedrock (InvokeModel) both carry these features; any other route to a Claude id does not.
const servedNatively = (model: ClaudeToolCapabilityModel): boolean =>
  model.backend === ModelBackend.Anthropic || model.backend === ModelBackend.Bedrock;

/**
 * The seed tables' verdict for a model they name, or undefined for one they do not. A model named by its
 * Claude version gets every flag, computed exactly as the tables were read before the catalog carried them.
 * One named only by the forced tool_choice deny-list (a patch version, a gateway prefix) or by
 * REFUSAL_FALLBACK_MODELS gets just those flags, so its other flags still come from the catalog or the default.
 */
export function seedApiSurface(
  model: Pick<ApiSurfaceModel, 'id' | 'backend' | 'adapterFamily'>
): Partial<ApiSurface> | undefined {
  if (!seedDescribes(model)) {
    const partial: Partial<ApiSurface> = {};
    if (NO_FORCED_TOOL_CHOICE_FAMILY.test(model.id)) partial.forcedToolChoice = false;
    if (REFUSAL_FALLBACK_MODELS.has(model.id)) partial.refusalFallback = true;
    return Object.keys(partial).length > 0 ? partial : undefined;
  }
  const version = claudeFamilyVersion(model.id);
  const listed = (versions: ReadonlySet<string>) => version !== null && versions.has(version);
  return {
    forcedToolChoice: !NO_FORCED_TOOL_CHOICE_FAMILY.test(model.id),
    assistantPrefill: !listed(NO_ASSISTANT_PREFILL_VERSIONS),
    toolSearch: listed(TOOL_SEARCH_VERSIONS),
    toolChanges: listed(TOOL_CHANGES_VERSIONS),
    deferredToolAddition: servedByDirectAnthropic(model)
      ? listed(DEFERRED_ADDITION_ANTHROPIC_VERSIONS)
      : listed(DEFERRED_ADDITION_BEDROCK_VERSIONS),
    refusalFallback: REFUSAL_FALLBACK_MODELS.has(model.id),
  };
}

/** Whether the seed tables give the model a full verdict, so nothing needs inheriting for it. */
export function seedDescribes(model: Pick<ApiSurfaceModel, 'id'>): boolean {
  const version = claudeFamilyVersion(model.id);
  return version !== null && SEEDED_VERSIONS.has(version);
}

/**
 * The verdict for a model neither the catalog nor the seed describes. Every adaptive-thinking model the
 * seed tables name rejects a prefill and several reject a forced tool_choice, while downgrading a forced
 * choice to `auto` plus `strict` works on all of them, so an unknown adaptive model gets neither. Any other
 * model keeps the permissive answer it always had. Optional features stay off until someone states them,
 * and a refusal surfaces as a decline rather than routing around it.
 */
function defaultApiSurface(model: ApiSurfaceModel): ApiSurface {
  const adaptive = model.thinkingStyle === 'adaptive';
  return {
    forcedToolChoice: !adaptive,
    assistantPrefill: !adaptive,
    toolSearch: false,
    toolChanges: false,
    deferredToolAddition: false,
    refusalFallback: false,
  };
}

/** Each apiSurface flag from the catalog record, else the seed tables, else the default. */
export function resolveApiSurface(model: ApiSurfaceModel): ApiSurface {
  const seed = seedApiSurface(model);
  const fallback = defaultApiSurface(model);
  const resolved = { ...fallback };
  for (const key of API_SURFACE_KEYS) resolved[key] = model[key] ?? seed?.[key] ?? fallback[key];
  return resolved;
}

// A sibling accepting these says nothing about this model, and sending either to a model that rejects it is a 400.
const NARROW_ONLY_KEYS = ['forcedToolChoice', 'assistantPrefill'] as const;

/**
 * The flags `model` (which states none) takes from a sibling's: the optional request features as the
 * sibling has them, and the NARROW_ONLY_KEYS only where the sibling narrows what the model would resolve
 * to on its own. refusalFallback is never copied: routing around a decline stays a seed or operator decision.
 */
export function inheritApiSurface(model: ApiSurfaceModel, sibling: Partial<ApiSurface>): Partial<ApiSurface> {
  const own = resolveApiSurface(model);
  const inherited = { ...sibling };
  delete inherited.refusalFallback;
  for (const key of NARROW_ONLY_KEYS) {
    const value = inherited[key];
    if (value !== undefined) inherited[key] = value && own[key];
  }
  return inherited;
}

/**
 * Whether the model accepts a forced `tool_choice`. Adapters downgrade a forced choice to `auto` + `strict`
 * otherwise. A bare id is still accepted, as the pre-catalog signature took one.
 */
export function supportsForcedToolChoice(model: string | ApiSurfaceModel): boolean {
  return resolveApiSurface(typeof model === 'string' ? { id: model } : model).forcedToolChoice;
}

/** Whether a `stop_reason: 'refusal'` is thrown into the fallback chain instead of surfacing as a decline. */
export function refusalFallsBack(model: ApiSurfaceModel): boolean {
  return resolveApiSurface(model).refusalFallback;
}

/** Whether the model accepts the tool search server tool and `defer_loading` on tool definitions. */
export function supportsToolSearch(model: RoutedApiSurfaceModel): boolean {
  return servedNatively(model) && resolveApiSurface(model).toolSearch;
}

/** Whether a system-role message can carry `tool_addition` / `tool_removal` blocks. */
export function supportsToolChanges(model: RoutedApiSurfaceModel): boolean {
  return servedNatively(model) && resolveApiSurface(model).toolChanges;
}

/** Whether the model accepts a final assistant turn for it to continue. */
export function supportsAssistantPrefill(model: ApiSurfaceModel): boolean {
  return resolveApiSurface(model).assistantPrefill;
}

/**
 * supportsToolChanges, narrowed to models whose `/api/ai/v1/completions` adapter keeps the messages in place and sends the beta.
 * Bedrock is left out until mid-conversation tool changes are verified there.
 */
export function completionsSupportsToolChanges(model: RoutedApiSurfaceModel): boolean {
  return servedByDirectAnthropic(model) && supportsToolChanges(model);
}

/**
 * Whether in-app chat may send optional tools with `defer_loading: true` and surface them with a
 * `tool_addition` system message, on the adapter the model actually dispatches to.
 */
export function chatSupportsDeferredToolAddition(model: RoutedApiSurfaceModel): boolean {
  return servedByClaudeAdapter(model) && resolveApiSurface(model).deferredToolAddition;
}

/** supportsToolSearch, narrowed to models whose `/api/ai/v1/completions` adapter actually forwards it. */
export function completionsSupportsToolSearch(model: RoutedApiSurfaceModel): boolean {
  return servedByClaudeAdapter(model) && supportsToolSearch(model);
}
