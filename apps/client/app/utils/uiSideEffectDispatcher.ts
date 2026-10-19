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
   * True only for the first dispatch of a reply that arrived (finished
   * streaming) in this client session: "this just happened, apply it". Anything
   * else - a session load, a reload, a refetch or remount of an older reply - is
   * a replay and must leave this unset, because a handler may auto-apply live
   * effects over state the user has changed since. Render-path callers gate it
   * with claimLiveDispatch(). Handlers decide what live vs replay means for their
   * effect types.
   */
  live?: boolean;
  /**
   * Stable id of the quest/message these effects belong to, so a handler can
   * apply each live quest exactly once across the two live dispatch paths
   * (streaming-completion handler and render-pipeline dispatcher).
   */
  dedupeKey?: string;
}

// In-memory ledger of which replies (keyed by quest/message id) have been dispatched,
// shared by every dispatch path so each reply is applied live at most once and
// replayed at most once per view of its session. Deliberately not persisted: a reply
// that finished before this page loaded was never seen in flight, so a reload can
// only replay it.
const inFlightKeys = new Set<string>();
const liveClaimedKeys = new Set<string>();
/** Dispatched (live or replay) reply key -> the session it belongs to. */
const dispatchedKeys = new Map<string, string>();

/** Record that the reply with this key was seen unfinished (streaming) in this client session. */
export function noteReplyInFlight(key: string): void {
  if (!liveClaimedKeys.has(key)) inFlightKeys.add(key);
}

/**
 * Claim the single live dispatch for a reply. Returns true at most once per key,
 * and only for a reply noted in flight in this client session; every later call
 * (remount, refetch, the other live dispatch path) returns false.
 */
export function claimLiveDispatch(key: string, sessionId = ''): boolean {
  if (!inFlightKeys.has(key) || liveClaimedKeys.has(key)) return false;
  inFlightKeys.delete(key);
  liveClaimedKeys.add(key);
  dispatchedKeys.set(key, sessionId);
  return true;
}

/**
 * Claim the replay (a dispatch without `live`) of a finished reply. Returns true once
 * per reply until its session is released with forgetSessionDispatches; false for a
 * reply already dispatched in this view of the session, or one still in flight (its
 * completion will be live). Handlers may rebuild derived state from replays, so a
 * reply must not be replayed twice into the same view.
 */
export function claimReplayDispatch(key: string, sessionId = ''): boolean {
  if (inFlightKeys.has(key) || dispatchedKeys.has(key)) return false;
  dispatchedKeys.set(key, sessionId);
  return true;
}

/**
 * Release a session's dispatched replies so the next view of it replays them again
 * (live claims stay spent). Called when the session view is left (SessionMiddle).
 */
export function forgetSessionDispatches(sessionId: string): void {
  for (const [key, owner] of dispatchedKeys) {
    if (owner === sessionId) dispatchedKeys.delete(key);
  }
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
