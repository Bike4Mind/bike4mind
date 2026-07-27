import { Logger } from '@bike4mind/observability';
/**
 * Runtime safety net for deprecated model IDs.
 *
 * When a model ID stored in the database or passed from a user session
 * references a deprecated/retired model, this resolver maps it to the
 * closest modern equivalent so the request doesn't fail at the API layer.
 *
 * Two tables feed it: the catalog overlay below (lifecycle.replacedBy on rows
 * the catalog marks deprecated or retired, refreshed by getAvailableModels)
 * and the static map, which is the cold-start seed the catalog overlay
 * gradually makes redundant.
 *
 * The console.warn produces a CloudWatch-searchable `[model-sunset]` signal.
 */

/** Exported for the stale-reference report, which audits these targets. */
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
  // one must be upgraded here to avoid a hard API failure. Models with a future shutdown date
  // keep their real ID (they still resolve) and are only hidden from the picker via
  // deprecationDate in the catalog.
  'gpt-5-chat-latest': 'gpt-5.5',
  'gpt-5.1-chat-latest': 'gpt-5.5',
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

export function resolveDeprecatedModelId(modelId: string, context?: string): string {
  let resolved = modelId;
  const visited = new Set<string>([modelId]);

  for (let hop = 0; hop < MAX_RESOLUTION_HOPS; hop++) {
    const next = successorOf(resolved);
    if (!next || visited.has(next)) break;
    visited.add(next);
    resolved = next;
  }

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
