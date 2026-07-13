/**
 * useAgentExecutionStore - Zustand store for in-flight ReAct agent executions.
 *
 * Subscribes to server->client WebSocket events via
 * `useAgentExecutionSubscriptions` and lets the iteration renderer, abort
 * button, permission card, and reconnect banner all read from a single
 * source of truth.
 *
 * Shape designed for nested executions from day one - each parent execution
 * owns a `childExecutions` map keyed by `childExecutionId`, so subagent events
 * from `delegate_to_agent` slot in without a parallel top-level store.
 * Visualization of children retains the data for a follow-up change.
 */

import { create } from 'zustand';
import type { IAgentStep } from '@bike4mind/common';
import { mergeChildExecutionsPreferringMoreIterations } from '@client/app/hooks/mergeChildExecutions';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

// Status tuple lives in `@bike4mind/common` so the wire schema can type
// `status` as a Zod enum (was `z.string()`). Re-exported here to preserve
// the established `@client/app/stores/useAgentExecutionStore` import surface
// and keep every "is this still running?" check derived from a single tuple.
import {
  AGENT_EXECUTION_STATUSES,
  ACTIVE_AGENT_EXECUTION_STATUSES,
  type AgentExecutionStatus,
} from '@bike4mind/common';
export { AGENT_EXECUTION_STATUSES, ACTIVE_AGENT_EXECUTION_STATUSES, type AgentExecutionStatus };

const ACTIVE_STATUS_SET: ReadonlySet<AgentExecutionStatus> = new Set(ACTIVE_AGENT_EXECUTION_STATUSES);

export function isActiveStatus(status: AgentExecutionStatus): boolean {
  return ACTIVE_STATUS_SET.has(status);
}

export interface IterationStep {
  iteration: number;
  step: IAgentStep;
  isComplete: boolean;
  receivedAt: number;
}

export interface ChildExecution {
  executionId: string;
  agentName: string;
  model?: string;
  thoroughness?: string;
  maxIterations?: number;
  status: AgentExecutionStatus;
  iterations: IterationStep[];
  totalCredits?: number;
  finalAnswer?: string;
  error?: string;
  isTimeout?: boolean;
  /** True when the parent's `delegate_to_agent` set `background: true` - the
   * orchestrator did not wait for this child, and the UI surfaces it via the
   * header badge + completion toast instead of nesting it inline under the
   * triggering iteration step. */
  isBackground?: boolean;
  /**
   * Buffer of streaming token deltas, keyed by 0-indexed iteration.
   * Populated by `subagent_text_delta` events and cleared when the iteration's
   * first persisted step arrives via `appendChildIteration`. The persisted
   * step contains the full text, so dropping the buffer at that point avoids
   * double-rendering. Not persisted to the server snapshot - replays only
   * show terminal steps.
   */
  pendingTextByIteration?: Record<number, string>;
  /** Latest humanized in-flight status from the server, e.g.
   * "Searching..." / "Reading file...". Updated by the `subagent_progress` WS
   * event for each `action` step the child agent emits. Rendered by
   * `SubagentStepNest` while the child is running so the user sees what the
   * child is doing right now instead of a static "N iterations - running" label. */
  lastProgress?: string;
  /** Grandchild executions spawned by this child. Keyed by childExecutionId,
   * insertion order matches server emission order (same ordinal invariant as
   * `ParentExecution.childExecutions`). Empty object when no grandchildren exist. */
  childExecutions: Record<string, ChildExecution>;
}

/**
 * Append an incoming step, collapsing partial-stream `final_answer` repeats.
 *
 * An older server build (or a replayed event stream) can emit multiple
 * `final_answer` steps for the SAME iteration, each holding the accumulated
 * text so far. One StepRow renders per entry, so appending them all stacks
 * dozens of progressively longer "Final Answer" rows. The last emission's
 * content is a superset of the earlier ones (the same contract server-side
 * `extractFinalAnswer` relies on), so an incoming `final_answer` REPLACES an
 * existing one for the same iteration instead of appending. Steps of other
 * types, and `final_answer`s of other iterations, append as-is.
 */
function appendCollapsingFinalAnswer(iterations: IterationStep[], incoming: IterationStep): IterationStep[] {
  if (incoming.step.type === 'final_answer') {
    const existingIdx = iterations.findLastIndex(
      it => it.iteration === incoming.iteration && it.step.type === 'final_answer'
    );
    if (existingIdx !== -1) {
      const next = iterations.slice();
      next[existingIdx] = incoming;
      return next;
    }
  }
  return [...iterations, incoming];
}

export interface PendingPermission {
  toolName: string;
  toolInput: unknown;
  iteration: number;
  requestedAt: number;
}

export interface ParentExecution {
  executionId: string;
  /** Session the dispatch was bound to. Set on startExecution; not all server
   * events carry it, so the client supplies it at dispatch time. */
  sessionId?: string;
  status: AgentExecutionStatus;
  iterations: IterationStep[];
  totalCreditsUsed: number;
  childExecutions: Record<string, ChildExecution>;
  pendingPermission?: PendingPermission;
  /** Final answer once `completed` arrives. */
  answer?: string;
  /** Surfaced reason on `failed`/`aborted` (e.g. 'aborted', 'max_handoffs_exceeded'). */
  failureReason?: string;
  /** Optional error message from `agent_error` or `failed.message`. */
  errorMessage?: string;
  startedAt: number;
  /** Last server event timestamp - used by UI to detect stalls. */
  lastEventAt: number;
  /** Highest iteration index the server has reported for this execution,
   * regardless of whether the corresponding `iteration_step` events have
   * streamed yet. Seeded from `reconnect_result.iterationCount` so the
   * status banner can render "iteration N" immediately on rehydration
   * before any new step events arrive. Live runs keep this in sync via
   * `appendIteration`. */
  lastKnownIteration: number;
}

interface AgentExecutionState {
  executions: Record<string, ParentExecution>;
  /** Sessions awaiting their first `execution_started` event. Dispatch enqueues,
   * `execution_started` dequeues. FIFO ordering matches WS event ordering on a
   * single tab; concurrent dispatches are bounded by the server's
   * `concurrent_limit` check. */
  pendingDispatches: string[];
  /** Sessions awaiting their `reconnect_result` response. The server's payload
   * doesn't echo sessionId back (the response shape is kept stable), so we use
   * the same FIFO correlation as `pendingDispatches` to stamp the sessionId
   * onto the hydrated execution. WS event ordering is preserved per connection,
   * and mount-time reconnect is one-shot per session, so a queue is sufficient. */
  pendingReconnects: string[];

  // Lifecycle
  startExecution: (executionId: string, sessionId?: string) => void;
  setStatus: (executionId: string, status: AgentExecutionStatus) => void;
  appendIteration: (executionId: string, iteration: IterationStep) => void;
  recordCredits: (executionId: string, credits: number) => void;
  markCompleted: (executionId: string, answer: string | undefined, totalCreditsUsed: number) => void;
  markFailed: (executionId: string, reason: string, message?: string) => void;
  markAborted: (executionId: string) => void;
  setPendingPermission: (executionId: string, pending: PendingPermission | undefined) => void;
  /** Replace state from a reconnect snapshot - only resets fields the server can re-supply. */
  hydrateFromReconnect: (snapshot: {
    executionId: string;
    sessionId?: string;
    status: AgentExecutionStatus;
    totalCreditsUsed: number;
    iterationCount: number;
    pendingPermission?: PendingPermission;
    /**
     * Persisted iteration trace for step replay. When provided,
     * replaces `exec.iterations` so the IterationStream can re-render past
     * work alongside future live updates. Live `iteration_step` events
     * appended after hydrate continue to extend this array.
     */
    iterations?: IterationStep[];
    /**
     * Persisted child subagent snapshots for nested-step replay.
     * Same "replace if supplied" contract as `iterations`. The map is keyed
     * by `childExecutionId` matching `ChildExecution.executionId`. Insertion
     * order must match server creation order - `IterationStream` relies on
     * it for the delegate-action -> child ordinal mapping. Background children
     * are excluded; they render via the header badge, not the nest.
     */
    childExecutions?: Record<string, ChildExecution>;
  }) => void;
  /** Replace just `exec.iterations` without touching status/credits/permission.
   * Used by the REST-fallback path in `useAgentExecution` after the WS
   * `reconnect_result` already established the authoritative live state -
   * re-calling `hydrateFromReconnect` there would clobber any state that
   * advanced during the fetch (e.g. a permission request that arrived mid-fetch). */
  replaceIterations: (executionId: string, iterations: IterationStep[]) => void;
  /** Wholesale replacement of `exec.childExecutions` - the snapshot is the
   * new authoritative map. Use only when the caller is the source of truth
   * (e.g. `ReasoningDisclosure` rebuilding the replay from REST). For the
   * reconnect REST-fallback merge, use `mergeChildExecutions` so any live
   * in-flight children aren't wiped. The name makes the wholesale-replace
   * semantic explicit at the call site. */
  setChildExecutions: (executionId: string, childExecutions: Record<string, ChildExecution>) => void;
  /** Per-child merge of a REST-fallback snapshot into the live store, preferring
   * whichever side has more iterations per child. Internal helper composes the
   * tested `mergeChildExecutionsPreferringMoreIterations` contract so callers
   * can't accidentally drop live in-flight children by forgetting to merge -
   * the bug a standalone wholesale replace made too easy to write. */
  mergeChildExecutions: (executionId: string, replayed: Record<string, ChildExecution>) => void;

  // Subagent (in-process delegation)
  startChild: (
    executionId: string,
    child: {
      childExecutionId: string;
      agentName: string;
      model?: string;
      thoroughness?: string;
      maxIterations?: number;
      isBackground?: boolean;
      /** Ordered list of intermediate child executionIds between the top-level
       * execution and this child. Empty (or omitted) for depth-1 children.
       * Supplied by WS handlers that resolve grandchild events. */
      ancestorPath?: string[];
    }
  ) => void;
  appendChildIteration: (
    executionId: string,
    childExecutionId: string,
    iteration: IterationStep,
    ancestorPath?: string[]
  ) => void;
  /**
   * Append a streaming token delta to the child's per-iteration buffer.
   * Created lazily on first delta; cleared on first persisted step for that
   * iteration via `appendChildIteration`.
   */
  appendChildTextDelta: (
    executionId: string,
    childExecutionId: string,
    iteration: number,
    delta: string,
    ancestorPath?: string[]
  ) => void;
  /** Record the latest humanized in-flight status for a child. No-op when
   * the child is not in the store yet (e.g. a stray `subagent_progress` event
   * arriving before `subagent_started`) - the renderer falls back to the
   * iteration-count label until the next progress event lands. */
  setChildProgress: (executionId: string, childExecutionId: string, status: string, ancestorPath?: string[]) => void;
  completeChild: (
    executionId: string,
    childExecutionId: string,
    payload: { totalCredits: number; iterations: number; finalAnswer?: string },
    ancestorPath?: string[]
  ) => void;
  failChild: (
    executionId: string,
    childExecutionId: string,
    payload: { error: string; isTimeout?: boolean; partialAnswer?: string },
    ancestorPath?: string[]
  ) => void;

  // Dispatch correlation
  registerPendingDispatch: (sessionId: string) => void;
  consumePendingDispatch: () => string | undefined;
  registerPendingReconnect: (sessionId: string) => void;
  consumePendingReconnect: () => string | undefined;

  // Cleanup
  clear: (executionId: string) => void;
  /** Remove all executions bound to `sessionId`. Used to evict prior runs when
   * the same session starts a new dispatch - keeps the store bounded for
   * long-lived tabs. */
  clearForSession: (sessionId: string) => void;
  clearAll: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyExecution(executionId: string): ParentExecution {
  const now = Date.now();
  return {
    executionId,
    status: 'pending',
    iterations: [],
    totalCreditsUsed: 0,
    childExecutions: {},
    startedAt: now,
    lastEventAt: now,
    lastKnownIteration: 0,
  };
}

function withExecution<T extends ParentExecution>(
  state: AgentExecutionState,
  executionId: string,
  mutate: (exec: T) => T
): Record<string, ParentExecution> {
  const existing = (state.executions[executionId] as T | undefined) ?? (emptyExecution(executionId) as T);
  const next = mutate(existing);
  next.lastEventAt = Date.now();
  return { ...state.executions, [executionId]: next };
}

function emptyChild(executionId: string): ChildExecution {
  return { executionId, agentName: 'unknown', status: 'running', iterations: [], childExecutions: {} };
}

function withChildNode(
  node: ChildExecution,
  ancestorPath: string[],
  targetId: string,
  mutate: (child: ChildExecution) => ChildExecution
): ChildExecution {
  if (ancestorPath.length === 0) {
    const existing = node.childExecutions[targetId] ?? emptyChild(targetId);
    return { ...node, childExecutions: { ...node.childExecutions, [targetId]: mutate(existing) } };
  }
  const [head, ...rest] = ancestorPath;
  const next = node.childExecutions[head];
  if (!next) return node;
  return { ...node, childExecutions: { ...node.childExecutions, [head]: withChildNode(next, rest, targetId, mutate) } };
}

function withChild(
  parent: ParentExecution,
  childExecutionId: string,
  mutate: (child: ChildExecution) => ChildExecution
): ParentExecution {
  const existing = parent.childExecutions[childExecutionId] ?? emptyChild(childExecutionId);
  return {
    ...parent,
    childExecutions: { ...parent.childExecutions, [childExecutionId]: mutate(existing) },
  };
}

/**
 * Mutate a child at an arbitrary depth. `ancestorPath` is the ordered list of
 * intermediate child executionIds between the top-level parent and the target
 * (empty for depth-1 children, `[childId]` for grandchildren, etc.).
 */
function withChildDeep(
  parent: ParentExecution,
  ancestorPath: string[],
  targetId: string,
  mutate: (child: ChildExecution) => ChildExecution
): ParentExecution {
  if (ancestorPath.length === 0) {
    return withChild(parent, targetId, mutate);
  }
  const [head, ...rest] = ancestorPath;
  const ancestor = parent.childExecutions[head];
  if (!ancestor) {
    console.warn(
      '[withChildDeep] ancestor missing for id:',
      head,
      '— mutation dropped (out-of-order or misrouted event)'
    );
    return parent;
  }
  return {
    ...parent,
    childExecutions: {
      ...parent.childExecutions,
      [head]: withChildNode(ancestor, rest, targetId, mutate),
    },
  };
}

function findChildPathInNode(
  children: Record<string, ChildExecution>,
  targetId: string,
  current: string[]
): string[] | null {
  if (children[targetId]) return [...current, targetId];
  for (const [id, child] of Object.entries(children)) {
    const found = findChildPathInNode(child.childExecutions, targetId, [...current, id]);
    if (found) return found;
  }
  return null;
}

/**
 * Search all top-level executions for a child (at any depth) whose executionId
 * matches `targetId`. Returns the top-level execution id and the ancestor path
 * (list of intermediate child ids) so callers can route nested WS events into
 * the correct position in the store.
 */
export function findChildAnyDepth(
  executions: Record<string, ParentExecution>,
  targetId: string
): { topLevelId: string; ancestorPath: string[] } | undefined {
  for (const [topLevelId, exec] of Object.entries(executions)) {
    const path = findChildPathInNode(exec.childExecutions, targetId, []);
    if (path) return { topLevelId, ancestorPath: path.slice(0, -1) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAgentExecutionStore = create<AgentExecutionState>((set, get) => ({
  executions: {},
  pendingDispatches: [],
  pendingReconnects: [],

  registerPendingDispatch: sessionId => set(state => ({ pendingDispatches: [...state.pendingDispatches, sessionId] })),

  consumePendingDispatch: () => {
    const [head, ...rest] = get().pendingDispatches;
    set({ pendingDispatches: rest });
    return head;
  },

  registerPendingReconnect: sessionId => set(state => ({ pendingReconnects: [...state.pendingReconnects, sessionId] })),

  consumePendingReconnect: () => {
    const [head, ...rest] = get().pendingReconnects;
    set({ pendingReconnects: rest });
    return head;
  },

  startExecution: (executionId, sessionId) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        status: 'running',
        sessionId: sessionId ?? exec.sessionId,
      })),
    })),

  setStatus: (executionId, status) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({ ...exec, status })),
    })),

  appendIteration: (executionId, iteration) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        status: exec.status === 'pending' ? 'running' : exec.status,
        iterations: appendCollapsingFinalAnswer(exec.iterations, iteration),
        lastKnownIteration: Math.max(exec.lastKnownIteration, iteration.iteration),
      })),
    })),

  recordCredits: (executionId, credits) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        totalCreditsUsed: exec.totalCreditsUsed + credits,
      })),
    })),

  // A terminal run can't have a live permission request outstanding - the server
  // has resolved or abandoned it. `PermissionCard` renders purely on
  // `pendingPermission` presence (not status), so a lingering value would leave a
  // dead permission prompt on a completed/failed/aborted run. Clear it on every
  // terminal transition.
  markCompleted: (executionId, answer, totalCreditsUsed) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        status: 'completed',
        answer,
        totalCreditsUsed,
        pendingPermission: undefined,
      })),
    })),

  markFailed: (executionId, reason, message) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        status: 'failed',
        failureReason: reason,
        errorMessage: message,
        pendingPermission: undefined,
      })),
    })),

  markAborted: executionId =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        status: 'aborted',
        failureReason: 'aborted',
        pendingPermission: undefined,
      })),
    })),

  setPendingPermission: (executionId, pending) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        pendingPermission: pending,
        status: pending ? 'awaiting_permission' : exec.status,
      })),
    })),

  hydrateFromReconnect: snapshot =>
    set(state => ({
      executions: withExecution(state, snapshot.executionId, exec => ({
        ...exec,
        // Stamp the sessionId so `selectExecutionIdsForSession` picks up the
        // hydrated execution and `ActiveAgentExecutions` mounts the live UI.
        // Without this, the rehydrated entry is orphaned from any session and
        // the user sees nothing despite the server having an active run.
        sessionId: snapshot.sessionId ?? exec.sessionId,
        status: snapshot.status,
        totalCreditsUsed: snapshot.totalCreditsUsed,
        // Only restore a pending permission for a still-active run. A reconnect
        // snapshot for a terminal run can still carry a stale `pendingPermission`
        // (it was outstanding when the run ended); restoring it re-shows the
        // permission card on an already-finished run - the reconnect arm of the
        // same bug the terminal transitions above guard against.
        pendingPermission: isActiveStatus(snapshot.status) ? snapshot.pendingPermission : undefined,
        lastKnownIteration: Math.max(exec.lastKnownIteration, snapshot.iterationCount),
        // Step replay. Replace iterations only when the server actually
        // supplied them - `undefined` means "live-only reconnect" (legacy
        // behavior or large-trace fallback to REST) and we keep whatever's
        // already in the store. A REST-fallback path can re-call this with
        // `iterations` filled in once the fetch resolves.
        iterations: snapshot.iterations ?? exec.iterations,
        // Child subagent replay. Same "replace if supplied" semantics
        // as `iterations`. `undefined` means the server didn't ship children
        // (no children, or `childrenTruncated: true` - REST fallback path
        // handles the latter via `mergeChildExecutions`).
        childExecutions: snapshot.childExecutions ?? exec.childExecutions,
      })),
    })),

  replaceIterations: (executionId, iterations) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({ ...exec, iterations })),
    })),

  setChildExecutions: (executionId, childExecutions) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({ ...exec, childExecutions })),
    })),

  mergeChildExecutions: (executionId, replayed) =>
    set(state => ({
      executions: withExecution(state, executionId, exec => ({
        ...exec,
        childExecutions: mergeChildExecutionsPreferringMoreIterations(exec.childExecutions, replayed),
      })),
    })),

  startChild: (executionId, child) =>
    set(state => ({
      executions: withExecution(state, executionId, exec =>
        withChildDeep(exec, child.ancestorPath ?? [], child.childExecutionId, () => ({
          executionId: child.childExecutionId,
          agentName: child.agentName,
          model: child.model,
          thoroughness: child.thoroughness,
          maxIterations: child.maxIterations,
          status: 'running',
          iterations: [],
          childExecutions: {},
          isBackground: child.isBackground,
        }))
      ),
    })),

  appendChildIteration: (executionId, childExecutionId, iteration, ancestorPath) =>
    set(state => ({
      executions: withExecution(state, executionId, exec =>
        withChildDeep(exec, ancestorPath ?? [], childExecutionId, child => {
          // Clear the pending streaming buffer for this iteration once the
          // persisted step lands - the step's `content` is authoritative and
          // already includes everything that was streamed.
          let pendingTextByIteration = child.pendingTextByIteration;
          if (pendingTextByIteration && pendingTextByIteration[iteration.iteration] !== undefined) {
            const { [iteration.iteration]: _drop, ...rest } = pendingTextByIteration;
            pendingTextByIteration = Object.keys(rest).length > 0 ? rest : undefined;
          }
          return {
            ...child,
            iterations: appendCollapsingFinalAnswer(child.iterations, iteration),
            pendingTextByIteration,
          };
        })
      ),
    })),

  appendChildTextDelta: (executionId, childExecutionId, iteration, delta, ancestorPath) =>
    set(state => ({
      executions: withExecution(state, executionId, exec =>
        withChildDeep(exec, ancestorPath ?? [], childExecutionId, child => {
          const prev = child.pendingTextByIteration?.[iteration] ?? '';
          return {
            ...child,
            pendingTextByIteration: {
              ...(child.pendingTextByIteration ?? {}),
              [iteration]: prev + delta,
            },
          };
        })
      ),
    })),

  setChildProgress: (executionId, childExecutionId, status, ancestorPath) =>
    set(state => {
      // Don't auto-create a placeholder child for a stray `subagent_progress` -
      // unlike iteration steps, the progress string alone has no agentName
      // context, so we'd surface an "unknown" child until the next event lands.
      // The renderer only mounts the nest for children already in the store, so
      // dropping the event when nothing exists yet is the safer no-op.
      const exec = state.executions[executionId];
      if (!exec) return state;
      const path = ancestorPath ?? [];
      const target = path.reduce<Record<string, ChildExecution> | undefined>(
        (children, id) => children?.[id]?.childExecutions,
        exec.childExecutions
      );
      if (!target?.[childExecutionId]) return state;
      return {
        executions: withExecution(state, executionId, e =>
          withChildDeep(e, path, childExecutionId, child => ({ ...child, lastProgress: status }))
        ),
      };
    }),

  completeChild: (executionId, childExecutionId, payload, ancestorPath) =>
    set(state => ({
      executions: withExecution(state, executionId, exec =>
        withChildDeep(exec, ancestorPath ?? [], childExecutionId, child => ({
          ...child,
          status: 'completed',
          totalCredits: payload.totalCredits,
          finalAnswer: payload.finalAnswer,
          // Drop any in-flight streaming buffer - the child is terminal, so
          // a leftover "(streaming...)" group from an iteration that never
          // landed a persisted step would otherwise linger until `clear`.
          pendingTextByIteration: undefined,
        }))
      ),
    })),

  failChild: (executionId, childExecutionId, payload, ancestorPath) =>
    set(state => ({
      executions: withExecution(state, executionId, exec =>
        withChildDeep(exec, ancestorPath ?? [], childExecutionId, child => ({
          ...child,
          status: 'failed',
          error: payload.error,
          isTimeout: payload.isTimeout,
          finalAnswer: payload.partialAnswer,
          // Same reasoning as `completeChild`: a mid-stream failure can leave
          // a partial buffer for an iteration the agent never finished.
          pendingTextByIteration: undefined,
        }))
      ),
    })),

  clear: executionId =>
    set(state => {
      const { [executionId]: _, ...rest } = state.executions;
      return { executions: rest };
    }),

  clearForSession: sessionId =>
    set(state => {
      const next: Record<string, ParentExecution> = {};
      for (const [id, exec] of Object.entries(state.executions)) {
        if (exec.sessionId !== sessionId) next[id] = exec;
      }
      // Drain any orphaned pending dispatch entries for this session - if the
      // user retried after an error, the previous entry is still in the queue
      // and would otherwise pair with the new execution's `execution_started`.
      const pendingDispatches = state.pendingDispatches.filter(s => s !== sessionId);
      return { executions: next, pendingDispatches };
    }),

  clearAll: () => set({ executions: {} }),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const selectExecution =
  (executionId: string | null | undefined) =>
  (state: AgentExecutionState): ParentExecution | undefined =>
    executionId ? state.executions[executionId] : undefined;

export const selectActiveExecutions = (state: AgentExecutionState): ParentExecution[] =>
  Object.values(state.executions).filter(e => isActiveStatus(e.status));

/** Returns the list of executionIds bound to a session, sorted by start time.
 * Designed for stable shallow-equality comparison so consumers don't re-render
 * on every event - only when the membership changes. */
export const selectExecutionIdsForSession =
  (sessionId: string | null | undefined) =>
  (state: AgentExecutionState): string[] => {
    if (!sessionId) return [];
    const ids: { id: string; startedAt: number }[] = [];
    for (const exec of Object.values(state.executions)) {
      if (exec.sessionId === sessionId) ids.push({ id: exec.executionId, startedAt: exec.startedAt });
    }
    ids.sort((a, b) => a.startedAt - b.startedAt);
    return ids.map(x => x.id);
  };

/** Returns the earliest execution in a session that is currently waiting on a user permission
 * decision, as `{ executionId, toolName }`, or null. Drives the bottom-anchored approval beacon so
 * a pending PermissionCard that has scrolled out of view still gets surfaced where the user is.
 * Shape is stable under `useShallow` (same values compare equal; null is a stable sentinel). */
export const selectPendingApprovalForSession =
  (sessionId: string | null | undefined) =>
  (state: AgentExecutionState): { executionId: string; toolName: string } | null => {
    if (!sessionId) return null;
    let earliest: ParentExecution | undefined;
    for (const exec of Object.values(state.executions)) {
      if (exec.sessionId !== sessionId || exec.status !== 'awaiting_permission' || !exec.pendingPermission) continue;
      if (!earliest || exec.startedAt < earliest.startedAt) earliest = exec;
    }
    return earliest?.pendingPermission
      ? { executionId: earliest.executionId, toolName: earliest.pendingPermission.toolName }
      : null;
  };

const ACTIVE_CHILD_STATUSES = ACTIVE_STATUS_SET;

export interface BackgroundChildSummary {
  parentExecutionId: string;
  child: ChildExecution;
}

// Stable singleton for the empty result. Returning a fresh `[]` on every call
// would trip `useShallow` into thinking the output changed each render - the
// consumer's `useSyncExternalStore` would then loop on "getSnapshot returned a
// new value" (React's "result of getSnapshot should be cached" invariant).
const EMPTY_BG_CHILDREN: readonly BackgroundChildSummary[] = Object.freeze([]);

// Cache wrapper objects per child reference so the selector returns the SAME
// `{ parentExecutionId, child }` object across calls when the child hasn't
// mutated. Without this, every call creates new wrapper objects, breaking
// `useShallow`'s index-wise `===` comparison and causing an infinite render
// loop in `BackgroundAgentBadge`.
//
// WeakMap auto-evicts entries when the child execution is garbage-collected,
// so this doesn't leak across `clear()` / `clearForSession()` calls.
const wrapperCache = new WeakMap<ChildExecution, BackgroundChildSummary>();

function getBgChildWrapper(parentExecutionId: string, child: ChildExecution): BackgroundChildSummary {
  const cached = wrapperCache.get(child);
  // Reuse the cached wrapper if it still belongs to the same parent. The
  // parent-check is defensive - a child reference doesn't migrate parents in
  // our model, but a fresh wrapper here is the safer fallback if it ever did.
  if (cached && cached.parentExecutionId === parentExecutionId) return cached;
  const wrapper: BackgroundChildSummary = { parentExecutionId, child };
  wrapperCache.set(child, wrapper);
  return wrapper;
}

/** Returns active (non-terminal) background subagent children across all
 * executions in a session. Used by the header badge to summarize how many
 * background agents are still running.
 *
 * Output references are stable across renders when the underlying state
 * hasn't changed: same array singleton when empty, same wrapper objects
 * when the same children are still active. This is required for
 * `useShallow` to actually short-circuit re-renders - see the wrapper
 * cache + `EMPTY_BG_CHILDREN` comments above.
 *
 * Return type is `readonly` to be honest about the empty singleton case -
 * `EMPTY_BG_CHILDREN` is frozen, and mutating the populated array post-return
 * would defeat the wrapper-cache invariant. Consumers read the list, they
 * don't write to it. */
export const selectActiveBackgroundChildrenForSession =
  (sessionId: string | null | undefined) =>
  (state: AgentExecutionState): readonly BackgroundChildSummary[] => {
    if (!sessionId) return EMPTY_BG_CHILDREN;
    const out: BackgroundChildSummary[] = [];
    for (const exec of Object.values(state.executions)) {
      if (exec.sessionId !== sessionId) continue;
      for (const child of Object.values(exec.childExecutions)) {
        if (child.isBackground && ACTIVE_CHILD_STATUSES.has(child.status)) {
          out.push(getBgChildWrapper(exec.executionId, child));
        }
      }
    }
    // Stable empty singleton for the common "no bg children" path. The
    // populated case is fine returning a new array - `useShallow` does
    // index-wise `===` and our wrappers are now cached, so successive calls
    // with the same children compare equal.
    return out.length === 0 ? EMPTY_BG_CHILDREN : out;
  };
