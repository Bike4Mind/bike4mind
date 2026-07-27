import { Logger } from '@bike4mind/observability';
import type { ModelInfo, SupersededModelInfo } from '@bike4mind/common';
/**
 * Runtime safety net for deprecated model IDs.
 *
 * When a model ID stored in the database or passed from a user session
 * references a deprecated/retired model, this resolver maps it to the
 * closest modern equivalent.
 *
 * Entry criterion is "superseded within its backend family", NOT "404s
 * upstream". A model that hard-fails is a loud, self-reporting bug someone
 * fixes within the hour; a model that still resolves but is generations stale
 * is a SILENT one, because a user cannot tell an obsolete model from a bad
 * product and so never reports it. The second failure mode is the more
 * damaging one, so both belong here.
 *
 * Invariant: every catalog entry carrying a `deprecationDate` must have a
 * mapping here, enforced by a test in resolveDeprecatedModel.test.ts. A model
 * hidden from the picker is still reachable through a session's pinned
 * `lastUsedModel`, so hiding it without mapping it strands existing sessions.
 *
 * Mappings must not silently raise a user's cost. Where the modern equivalent
 * is more expensive than what the user chose, prefer the cheapest CURRENT
 * model that preserves the original's intent (see grok-3-mini-fast below).
 *
 * Two tables feed the resolver: the catalog overlay below (lifecycle.replacedBy
 * on rows the catalog marks deprecated or retired, refreshed by
 * getAvailableModels) and this static map, the cold-start seed the catalog
 * overlay gradually makes redundant.
 *
 * The warn produces a CloudWatch-searchable `[model-sunset]` signal.
 */

/**
 * Exported for the stale-reference report, which audits these targets, and so
 * tests can enforce the deprecationDate <-> mapping invariant described above.
 */
export const DEPRECATED_MODEL_MAP: Record<string, string> = {
  // Bedrock models
  'anthropic.claude-3-5-sonnet-20240620-v1:0': 'global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-3-opus-20240229-v1:0': 'global.anthropic.claude-opus-4-8',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': 'global.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0': 'global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-3-haiku-20240307-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Anthropic-hosted models
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
  // OpenAI-hosted models retired from the API (https://platform.openai.com/docs/deprecations).
  // These are past their shutdown date and 404 upstream, so a session/agent still pinned to
  // one must be upgraded here to avoid a hard API failure.
  'gpt-5-chat-latest': 'gpt-5.5',
  'gpt-5.1-chat-latest': 'gpt-5.5',
  // xAI models superseded by Grok 4.5. These all still resolve upstream, so nothing here
  // prevents an API failure -- they are mapped because Grok 4.5 is cheaper AND strictly more
  // capable (reasoning, vision, 500K context, cache reads) than every one of them. Grok 3 in
  // particular has can_think:false and supportsVision:false at $3/$15 per 1M, against Grok
  // 4.5's $2/$6, so leaving a session pinned to it costs the user more for a worse answer.
  'grok-3': 'grok-4.5',
  'grok-3-fast': 'grok-4.5',
  'grok-2-1212': 'grok-4.5',
  'grok-2-vision-1212': 'grok-4.5',
  'grok-beta': 'grok-4.5',
  'grok-vision-beta': 'grok-4.5',
  // Not grok-4.5: Grok 3 Mini Fast is the budget reasoning tier ($0.60/$4), and Grok 4.5 would
  // be a cost increase. Grok 3 Mini is both current and cheaper ($0.30/$0.50) while keeping
  // can_think, so it preserves intent without raising the bill.
  'grok-3-mini-fast': 'grok-3-mini',
  // Deliberately NOT mapped: `grok-3-mini` ($0.30/$0.50, can_think) is current and has no
  // cheaper replacement. Mapping it to grok-4.5 would raise input cost 6.7x and output 12x
  // for a user who explicitly chose the budget tier.
};

/**
 * Catalog-sourced successors, consulted ahead of the static map (sec 5.10).
 * Replaced wholesale on every refresh so a successor an operator reverted stops
 * redirecting; a catalog fetch that fails OR comes back empty simply never
 * calls the updater, leaving the previous overlay standing.
 */
let replacedByOverlay: ReadonlyMap<string, string> = new Map();

export function updateReplacedByOverlay(entries: ReadonlyMap<string, string> | Record<string, string>): void {
  replacedByOverlay = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
}

/** Test-only: back to the static map alone, i.e. the cold-start state. */
export function resetReplacedByOverlay(): void {
  replacedByOverlay = new Map();
}

/** Read-only view for the stale-reference report. */
export function replacedByOverlayEntries(): ReadonlyMap<string, string> {
  return replacedByOverlay;
}

/**
 * Chain length cap. A successor can itself have been retired since, so the walk
 * follows a->b->c, but a catalog cycle or a runaway chain must terminate at a
 * bounded, reproducible answer rather than the newest hop available.
 */
const MAX_RESOLUTION_HOPS = 5;

const successorOf = (modelId: string): string | undefined =>
  replacedByOverlay.get(modelId) ?? DEPRECATED_MODEL_MAP[modelId];

/**
 * The resolution walk without the operator warning. Index builders resolve every
 * known sunset id at once, and emitting a `[model-sunset]` line per entry would
 * bury the ones that mark real traffic being redirected.
 */
export function resolveSuccessorChain(modelId: string): string {
  let resolved = modelId;
  const visited = new Set<string>([modelId]);

  for (let hop = 0; hop < MAX_RESOLUTION_HOPS; hop++) {
    const next = successorOf(resolved);
    if (!next || visited.has(next)) break;
    visited.add(next);
    resolved = next;
  }

  return resolved;
}

export function resolveDeprecatedModelId(modelId: string, context?: string): string {
  const resolved = resolveSuccessorChain(modelId);

  if (resolved === modelId) return modelId;

  // One warning per resolution naming the endpoints, not one per hop: the
  // intermediate ids are bookkeeping, and the pair is what an operator greps.
  Logger.globalInstance.warn(
    `[model-sunset] Resolved deprecated model: ${modelId} -> ${resolved} (context: ${context ?? 'unknown'})`
  );
  return resolved;
}

/** Statuses whose replacedBy is a live redirect rather than a plan. */
const SUNSET_STATUSES: ReadonlySet<string> = new Set(['deprecated', 'retired']);

/**
 * The overlay getAvailableModels installs: every catalog model that is both
 * sunset and names a successor. An active model carrying a replacedBy hint is a
 * plan for later, so it must not redirect traffic today.
 */
export function catalogSuccessors(
  lifecycles: ReadonlyMap<string, { status?: string; replacedBy?: string }>
): Map<string, string> {
  const successors = new Map<string, string>();
  for (const [modelId, lifecycle] of lifecycles) {
    if (lifecycle.replacedBy && SUNSET_STATUSES.has(lifecycle.status ?? '')) {
      successors.set(modelId, lifecycle.replacedBy);
    }
  }
  return successors;
}

/**
 * The client-facing view of both successor tables: every id that resolves to
 * something else, with display names for the pin and its replacement.
 *
 * The picker hides retired models, but a session's pinned `lastUsedModel` can
 * still point at one (or at a model that is merely superseded, not yet retired),
 * so the client needs to name that pin and offer its replacement rather than
 * silently resuming on it.
 *
 * Sources ids from the catalog overlay AND the static map, and resolves through
 * the same `successorOf` chain the server uses, so the replacement offered here
 * cannot diverge from the one a pinned request actually lands on.
 *
 * @param allModels pre-deprecation-filter list, used only to name pins the
 *   filter has already removed; an id absent here falls back to its raw id.
 * @param currentModels what the caller can actually run. A mapping whose target
 *   is missing from it (backend not configured, itself retired, private to
 *   someone else) is dropped rather than surfaced as a dead prompt.
 */
export function buildSupersededIndex(allModels: ModelInfo[], currentModels: ModelInfo[]): SupersededModelInfo[] {
  const nameOf = (id: string) => allModels.find(m => m.id === id)?.name ?? id;
  const sunsetIds = new Set([...replacedByOverlay.keys(), ...Object.keys(DEPRECATED_MODEL_MAP)]);

  return [...sunsetIds].flatMap(id => {
    const replacementId = resolveSuccessorChain(id);
    if (replacementId === id) return [];
    const replacement = currentModels.find(m => m.id === replacementId);
    if (!replacement) return [];
    return [{ id, name: nameOf(id), replacementId, replacementName: replacement.name }];
  });
}
