/**
 * Generic UI side-effect dispatch bus.
 *
 * Completions can carry UI side-effects (persisted on the quest / streamed over
 * the WebSocket). Core owns only the dispatch SEAM: product surfaces register a
 * handler for the effect types they understand, and the three core call sites
 * (streaming handler + render-pipeline dispatchers) stay product-neutral. A
 * fork with no registered handlers dispatches nothing, harmlessly.
 *
 * Registration timing: a surface's handler module registers at import time
 * (side effect). Effects dispatched before the surface has ever loaded are
 * dropped here - that is safe because pending-effect state is only consumable
 * on the surface itself, and the surface re-renders its quest list on mount,
 * which re-dispatches persisted effects through the then-registered handler.
 */

/**
 * A UI side-effect payload from the WebSocket stream or persisted quest.
 * The Zod schema uses `z.string()` for the type field (not a literal union),
 * so we accept the wider type here to avoid casts at every call site.
 */
export interface StreamedSideEffect {
  type: string;
  payload: unknown;
}

export interface DispatchOptions {
  /**
   * Whether these effects are arriving live from a streaming completion, as
   * opposed to being replayed when an existing session loads. Handlers decide
   * what live vs replay means for their effect types.
   */
  live?: boolean;
  /**
   * Stable id of the quest/message these effects belong to, so a handler can
   * apply each live quest exactly once across the two live dispatch paths
   * (streaming-completion handler and render-pipeline dispatcher).
   */
  dedupeKey?: string;
}

/** Returns the number of effects it dispatched. */
export type UiSideEffectHandler = (effects: StreamedSideEffect[], options: DispatchOptions) => number;

const handlers = new Set<UiSideEffectHandler>();

/** Register a surface's handler. Returns an unregister function. */
export function registerUiSideEffectHandler(handler: UiSideEffectHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Dispatch UI side-effects to every registered handler. Standalone function
 * (not a hook) so it can be called from both the WebSocket streaming handler
 * and from React components. Returns the total number of effects dispatched.
 */
export function dispatchUiSideEffects(effects: StreamedSideEffect[], options: DispatchOptions = {}): number {
  let dispatched = 0;
  for (const handler of handlers) {
    dispatched += handler(effects, options);
  }
  if (dispatched === 0 && effects.length > 0) {
    // Diagnostic parity with the pre-registry dispatcher: an effect type no
    // registered handler understands (version skew, surface not loaded) should
    // be visible, not silently dropped.
    console.warn(
      '[uiSideEffectDispatcher] No registered handler dispatched any of the effects:',
      effects.map(e => e.type)
    );
  }
  return dispatched;
}
