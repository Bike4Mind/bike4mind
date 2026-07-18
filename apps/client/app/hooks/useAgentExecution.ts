/**
 * Agent execution WebSocket hooks for ReAct agent runs.
 *
 * Split into two hooks so the subscription side can mount at app root
 * (survives route navigation) and the dispatch side can mount per-route
 * (close to the send-button caller). Combining them in one hook caused
 * duplicate `appendIteration` calls when both the global subscriber and
 * the route-scoped `useSendMessage` registered listeners.
 *
 * - `useAgentExecutionSubscriptions()` - registers WS listeners exactly
 *   once at app root. Pipes server events into the Zustand store.
 * - `useAgentExecutionDispatch()` - imperative API for client->server
 *   commands (start / abort / permission_response / reconnect). Typed at
 *   the call site since the to-server schema is validated by the
 *   server's own Zod parsers.
 *
 * Why split: route swaps like `/new -> /notebooks/$id` unmount
 * `SessionContainer`, which used to tear down the listeners during the
 * exact window when `execution_started` arrives, silently dropping the
 * first events. Subscriptions live at the WebsocketProvider scope now.
 */

import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { router } from '@client/app/router';
import { AGENT_TRACE_ROUTE, buildAgentTraceSearch } from '@client/app/utils/agentTraceLink';
import type { IMessageDataToClient } from '@bike4mind/common';
import {
  useAgentExecutionStore,
  findChildAnyDepth,
  AGENT_EXECUTION_STATUSES,
  type AgentExecutionStatus,
  type ChildExecution,
  type IterationStep,
} from '@client/app/stores/useAgentExecutionStore';
import type { IAgentStep, GenerateImageToolCall } from '@bike4mind/common';
import { appendReplyToLatestOptimisticBubble, swapOptimisticPromptBubbleId } from '@client/app/utils/llm';
import { dispatchUiSideEffects } from '@client/app/utils/uiSideEffectDispatcher';

// Mirror the shape the server validates in
// `apps/client/server/websocket/agentExecute.ts`. Kept inline because the
// schema isn't exported from b4m-core (server-only file).
interface AgentExecuteStart {
  action: 'agent_execute';
  command: 'start';
  sessionId: string;
  questId: string;
  query: string;
  model: string;
  organizationId?: string;
  /**
   * Optional persisted IAgent id. When present, the executor
   * resolves the agent's orchestration profile and uses it for the run. When
   * absent, the executor builds a synthetic default profile from admin
   * settings - the path the Agent-mode toggle dispatches through.
   */
  agentId?: string;
  enabledTools?: string[];
  maxIterations?: number;
  // Knowledge / file context forwarded for first-iteration materialization.
  messageFileIds?: string[];
  sessionFabFileIds?: string[];
  // LLM runtime knobs.
  temperature?: number;
  maxTokens?: number;
  thinking?: { enabled: boolean; budget_tokens?: number };
  // Memento parity with chat_completion. Server fires
  // `LLMEvents.CompletionCompleted` on terminal `completed` when true,
  // matching the memento-creation behavior of the chat_completion flow.
  enableMementos?: boolean;
  /**
   * Lattice parity with chat_completion. When true, the executor
   * appends the Lattice tools to the agent's toolbelt so the ReAct loop gets
   * the same context-window optimization the chat-completion flow offers.
   */
  enableLattice?: boolean;
  /**
   * User's selected image-generation config. Forwarded
   * so the executor's image_generation / edit_image tools resolve a model;
   * without it they short-circuit with "Image model selection required" (no
   * picker UI in a headless run). Server-parsed via `GenerateImageToolCallSchema.partial()`.
   */
  imageConfig?: GenerateImageToolCall;
  /**
   * Provenance of the routing decision that produced this dispatch.
   * Persisted onto the resulting `IChatHistoryItem.routingSource` so the
   * client can render the `AutoRouteBadge` over auto-routed responses
   * (classifier- or rule-based complexity-routed).
   */
  routingSource?: 'mention' | 'agent_literal' | 'toggle' | 'classifier' | 'user-default' | 'complexity';
}

interface AgentExecuteAbort {
  action: 'agent_execute';
  command: 'abort';
  executionId: string;
}

interface AgentExecutePermissionResponse {
  action: 'agent_execute';
  command: 'permission_response';
  executionId: string;
  toolName: string;
  approved: boolean;
  rememberForSession?: boolean;
}

interface AgentExecuteReconnect {
  action: 'agent_execute';
  command: 'reconnect';
  executionId?: string;
  sessionId?: string;
}

export type AgentExecuteCommand =
  AgentExecuteStart | AgentExecuteAbort | AgentExecutePermissionResponse | AgentExecuteReconnect;

/** Length cap for the background-completion toast preview. The spec asks for
 * 200 chars; server-side truncation on subagent steps is 2KB, so the final
 * answer can be much longer than that and a header-toast surface would feel
 * overwhelming without a tight cap. Counts code points, not UTF-16 code units,
 * so emoji and astral chars don't get sliced into lone surrogates. */
const BACKGROUND_TOAST_PREVIEW_LENGTH = 200;

function truncatePreview(text: string, max: number): string {
  // `Array.from` iterates by code point (handles surrogate pairs correctly),
  // so emoji and other supplementary-plane chars stay intact across the cut.
  // Pure-grapheme awareness (Intl.Segmenter) would be stricter, but the cap is
  // approximate by design; the toast is a preview, not a structured value.
  const codePoints = Array.from(text);
  if (codePoints.length <= max) return text;
  return `${codePoints.slice(0, max).join('').trimEnd()}…`;
}

/**
 * Resolve which top-level execution owns `executionId` (directly or as a
 * descendant child) and return the ancestor path for store routing.
 * Returns undefined when the id is not found (stale/out-of-order event).
 */
function resolveParentContext(
  executions: ReturnType<typeof useAgentExecutionStore.getState>['executions'],
  executionId: string
): { topLevelId: string; ancestorPath: string[] } | undefined {
  // Top-level execution: children go directly in exec.childExecutions.
  if (executions[executionId]) return { topLevelId: executionId, ancestorPath: [] };
  // Nested child: callers use the returned ancestorPath to place a NEW child
  // INSIDE executionId, so executionId itself must be the last entry in the path.
  const found = findChildAnyDepth(executions, executionId);
  if (!found) return undefined;
  return { topLevelId: found.topLevelId, ancestorPath: [...found.ancestorPath, executionId] };
}

function notifyBackgroundCompletion(agentName: string, finalAnswer?: string, onViewTrace?: () => void): void {
  const preview = finalAnswer ? truncatePreview(finalAnswer, BACKGROUND_TOAST_PREVIEW_LENGTH) : '';
  // Default Sonner toast (`toast(...)`) reads as "informational"; success
  // shade implies the user explicitly approved something, which they did not.
  // The toast is a launcher: a "View trace" action deep-links to the
  // run's reasoning trace on /agent-executions. The toast still auto-dismisses.
  toast(`${agentName} (background) finished${preview ? `: ${preview}` : ''}`, {
    duration: 10000,
    ...(onViewTrace ? { action: { label: 'View trace', onClick: onViewTrace } } : {}),
  });
}

export function useAgentExecutionSubscriptions(): void {
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();

  // Navigate via the `router` singleton, NOT useNavigate(): this hook's host
  // (AgentExecutionSubscriber) mounts in providers.tsx, OUTSIDE the
  // RouterProvider, so useNavigate() resolves to null and the toast "View
  // trace" click threw `Cannot read properties of null (reading 'navigate')`.
  // The singleton is the same router instance and works regardless of
  // React context, and being a stable module-level value it never re-runs the
  // WS subscription effect below.
  useEffect(() => {
    // Read actions imperatively via getState() so this component never
    // subscribes to store updates; otherwise every `iteration_step` would
    // re-render the (null-rendering) subscriber and run reconciliation
    // 10+ times per second during an active run.
    const store = useAgentExecutionStore.getState.bind(useAgentExecutionStore);

    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(
      subscribeToAction('execution_started', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'execution_started') return;
        // Pair this execution with the sessionId the dispatcher enqueued.
        // FIFO match works because WS preserves emit order per connection.
        const sessionId = store().consumePendingDispatch();
        store().startExecution(msg.executionId, sessionId);
        // Swap the optimistic prompt bubble's fake id for the real persisted
        // Quest id so the bubble survives a mid-run reload. Only
        // present when `handleStart` succeeded in writing the Quest; absent
        // when the write failed (legacy fallback path); in that case the
        // bubble remains optimistic-only as before.
        if (sessionId && msg.questId) {
          swapOptimisticPromptBubbleId(queryClient, sessionId, msg.questId);
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('iteration_step', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'iteration_step') return;
        store().appendIteration(msg.executionId, {
          iteration: msg.iteration,
          step: msg.step,
          isComplete: msg.isComplete,
          receivedAt: Date.now(),
        });
        // Apply any UI side-effects the tool emitted this iteration (e.g. optimizer
        // console populate) through the shared bus - the same one the chat path uses.
        // dedupeKey is executionId:iteration so a redelivered frame applies once, and
        // is distinct from the completion Quest id used on reload replay (SessionMiddle),
        // so live-apply and replay never collide.
        if (msg.uiSideEffects?.length) {
          dispatchUiSideEffects(msg.uiSideEffects, {
            live: true,
            dedupeKey: `${msg.executionId}:${msg.iteration}`,
          });
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('agent_text_delta', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'agent_text_delta') return;
        store().appendTextDelta(msg.executionId, msg.iteration, msg.delta);
      })
    );

    unsubscribers.push(
      subscribeToAction('progress', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'progress') return;
        if (typeof msg.creditsUsed === 'number') {
          store().recordCredits(msg.executionId, msg.creditsUsed);
        }
        if (msg.status && (AGENT_EXECUTION_STATUSES as readonly string[]).includes(msg.status)) {
          // Server `progress.status` is `z.string()` (forwarded from arbitrary
          // tool callbacks). Guard at the client so a typo or new upstream
          // value can't silently corrupt store state.
          store().setStatus(msg.executionId, msg.status as AgentExecutionStatus);
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('completed', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'completed') return;
        store().markCompleted(msg.executionId, msg.answer, msg.totalCreditsUsed);
        // Patch the user's optimistic prompt bubble with the final answer so
        // the chat history reflects the completed exchange immediately. The
        // server-side persistRunAsQuest writes the real Quest, which arrives
        // via the change-stream subscriber moments later and replaces this
        // optimistic entry; without this patch there's a visible gap between
        // the iteration stream unmounting (on terminal status) and the real
        // Quest arriving (seconds via change-stream).
        // mementoIds are forwarded so MementoIndicator renders now instead of
        // waiting for the change-stream (which is silently dropped when the
        // client-clock-set updatedAt is ahead of the server's value).
        const sessionId = store().executions[msg.executionId]?.sessionId;
        if (sessionId && msg.answer) {
          appendReplyToLatestOptimisticBubble(queryClient, sessionId, msg.answer, msg.executionId, msg.mementoIds);
        }
        // Refresh the Knowledge Base so files a tool generated this run (images, Excel -
        // persisted as FabFiles during the run) appear without a manual reload. The agent
        // path has its own subscription and so doesn't get the chat_completion hook's
        // invalidation (useSubscribeChatCompletion); without this, useGetFabFilesBySessionId's
        // 30-min staleTime hides them until the user navigates away and back. The FabFiles are
        // written mid-run, so they're already committed by the time `completed` fires.
        if (sessionId) {
          queryClient.invalidateQueries({ queryKey: ['fabFiles', 'own', { sessionId }] });
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('failed', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'failed') return;
        store().markFailed(msg.executionId, msg.reason, msg.message);
        // Same rationale as `completed` above: patch the prompt bubble so the
        // user sees a chat-history entry for the failed run without waiting
        // on the change-stream subscriber. Generic message (no internal
        // details) mirrors persistRunAsQuest's failure-path Quest body.
        const sessionId = store().executions[msg.executionId]?.sessionId;
        if (sessionId) {
          appendReplyToLatestOptimisticBubble(queryClient, sessionId, 'Agent execution failed.', msg.executionId);
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('resumed', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'resumed') return;
        store().setStatus(msg.executionId, 'running');
      })
    );

    unsubscribers.push(
      subscribeToAction('agent_error', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'agent_error') return;
        // Toast either way so the user sees the rejection. Pre-creation errors
        // (concurrent_limit, session_unauthorized, malformed_request) arrive
        // without an executionId, so without a toast they were invisible;
        // store would stay empty and the user wouldn't know the dispatch
        // failed.
        toast.error(msg.message ?? 'Agent execution failed', { duration: 6000 });
        if (msg.executionId) {
          store().markFailed(msg.executionId, 'agent_error', msg.message);
        } else {
          // Pre-creation rejection - drain the orphaned sessionId so the next
          // `execution_started` pairs with the correct session, not this stale one.
          store().consumePendingDispatch();
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('abort_acknowledged', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'abort_acknowledged') return;
        store().markAborted(msg.executionId);
        // Patch the optimistic prompt bubble with the abort reply so the
        // chat-history entry reflects the stopped run immediately. The
        // server-side persistRunAsQuest on the abort path writes the real
        // Quest; this just closes the gap before change-stream catches up.
        const sessionId = store().executions[msg.executionId]?.sessionId;
        if (sessionId) {
          appendReplyToLatestOptimisticBubble(queryClient, sessionId, 'Stopped by user.', msg.executionId);
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('permission_request', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'permission_request') return;
        store().setPendingPermission(msg.executionId, {
          toolName: msg.toolName,
          toolInput: msg.toolInput,
          iteration: msg.iteration,
          requestedAt: Date.now(),
        });
      })
    );

    unsubscribers.push(
      subscribeToAction('reconnect_result', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'reconnect_result') return;
        // Always drain the pending sessionId, even on a `found: false` response;
        // otherwise the queue would carry a stale entry and pair it with the
        // next reconnect, mis-attributing the execution to the wrong session.
        const sessionId = store().consumePendingReconnect();
        if (!msg.found || !msg.executionId || !msg.status) return;
        const executionId = msg.executionId;

        // Step replay. The server includes `steps` inline when the
        // checkpoint fits in the WS frame budget; otherwise it sets
        // `stepsTruncated: true` and we fall back to fetching the trace via
        // `/api/agent-executions/[id]` (which the disclosure already uses).
        // Each step carries `metadata.iteration` since the
        // ReActAgent stamps it at emit time; older checkpoints without that
        // field fall back to the step's index for grouping. We prefer
        // `metadata.timestamp` for `receivedAt` so the replayed trace keeps
        // its real emit ordering instead of hydrate-time synthetic stamps.
        const buildIterations = (steps: IAgentStep[] | undefined): IterationStep[] | undefined => {
          if (!steps || steps.length === 0) return undefined;
          const now = Date.now();
          return steps.map((step, idx) => ({
            iteration: step.metadata?.iteration ?? idx,
            step,
            isComplete: false,
            receivedAt: step.metadata?.timestamp ?? now + idx,
          }));
        };

        // Child subagent replay. Map persisted child snapshots into
        // store-shaped `ChildExecution` entries. Object insertion order is
        // preserved (the server returns children in creation order), which
        // `IterationStream`'s delegate-action -> child ordinal mapping relies
        // on. Returns an empty record (NOT undefined) when the server
        // explicitly shipped `children: []`; the empty record signals
        // "authoritative empty" to `hydrateFromReconnect`, replacing any
        // stale child entries left over from a previous run in this tab.
        const buildChildren = (children: (typeof msg)['children']): Record<string, ChildExecution> | undefined => {
          if (!children) return undefined;
          const out: Record<string, ChildExecution> = {};
          const now = Date.now();
          for (const child of children) {
            const iterations: IterationStep[] = child.steps.map((step, idx) => ({
              iteration: step.metadata?.iteration ?? idx,
              step,
              isComplete: false,
              receivedAt: step.metadata?.timestamp ?? now + idx,
            }));
            out[child.executionId] = {
              executionId: child.executionId,
              agentName: child.agentName,
              model: child.model,
              status: child.status,
              iterations,
              totalCredits: child.totalCredits,
              finalAnswer: child.finalAnswer,
              error: child.error,
              isTimeout: child.isTimeout,
              // Snapshots exclude background children by construction (server
              // filters them out; they surface via the header badge, not the
              // nest), so this is always non-background on the replay path.
              isBackground: false,
              childExecutions: buildChildren(child.children) ?? {},
            };
          }
          return out;
        };

        store().hydrateFromReconnect({
          executionId,
          sessionId,
          status: msg.status,
          totalCreditsUsed: msg.totalCreditsUsed ?? 0,
          iterationCount: msg.iterationCount ?? 0,
          iterations: buildIterations(msg.steps),
          childExecutions: buildChildren(msg.children),
          pendingPermission: msg.pendingPermission
            ? {
                toolName: msg.pendingPermission.toolName,
                toolInput: msg.pendingPermission.toolInput,
                iteration: msg.iterationCount ?? 0,
                requestedAt:
                  msg.pendingPermission.requestedAt instanceof Date
                    ? msg.pendingPermission.requestedAt.getTime()
                    : new Date(msg.pendingPermission.requestedAt).getTime(),
              }
            : undefined,
        });

        // Truncated path: server omitted `steps` and/or `children` because
        // the persisted state exceeded the WS frame budget. Fetch the full
        // trace via REST and re-hydrate. Fire-and-forget: a network failure
        // should not crash the reconnect; we just leave the live trace empty
        // until iteration events arrive (same as the prior behavior).
        //
        // Race: live events may arrive while the REST fetch is in flight.
        // For iterations, capture the pre-fetch length so we can preserve
        // any live entries that appended (the dedup-by-receivedAt below).
        // For children, the merge prefers whichever side has more iterations
        // per child: REST for terminal children with a persisted trace, and
        // live store for in-flight children whose checkpoint isn't written
        // yet.
        if (msg.stepsTruncated || msg.childrenTruncated) {
          const liveBaselineLength = store().executions[executionId]?.iterations.length ?? 0;
          // 10s ceiling on the REST fallback; fire-and-forget, so a hung
          // fetch would otherwise pin the closure (and the live-trace slice
          // it captures) past tab close.
          fetch(`/api/agent-executions/${executionId}`, { signal: AbortSignal.timeout(10_000) })
            .then(r => (r.ok ? r.json() : null))
            .then((data: { steps?: IAgentStep[]; children?: (typeof msg)['children'] } | null) => {
              if (!data) return;
              // Iteration merge.
              if (msg.stepsTruncated && data.steps) {
                const replayed = buildIterations(data.steps);
                if (replayed) {
                  const currentIterations = store().executions[executionId]?.iterations ?? [];
                  const liveSinceReplay = currentIterations.slice(liveBaselineLength);
                  // Dedup the live slice against replayed entries; Lambda
                  // may have persisted a checkpoint that already includes a
                  // step that arrived live via WS during the fetch window.
                  // Without this, the merged trace shows the same step twice.
                  // `receivedAt` is sourced from `step.metadata.timestamp`, a
                  // stable join key with the live event.
                  const replayedTimestamps = new Set(replayed.map(s => s.receivedAt));
                  const deduped = liveSinceReplay.filter(s => !replayedTimestamps.has(s.receivedAt));
                  store().replaceIterations(executionId, [...replayed, ...deduped]);
                }
              }
              // Child snapshot merge. The store's `mergeChildExecutions`
              // applies the prefer-more-iterations contract internally, so the
              // call site can't forget to merge and silently drop live in-flight
              // children. The pure helper is still imported elsewhere; the unit
              // test in `mergeChildExecutions.test.ts` covers the contract.
              if (msg.childrenTruncated && data.children) {
                const replayed = buildChildren(data.children) ?? {};
                store().mergeChildExecutions(executionId, replayed);
              }
            })
            .catch(err => {
              // Leaving the live trace empty is the legacy
              // behavior, but a silent swallow hides systematic failures
              // (e.g. backend always returning 500 for large checkpoints).
              console.warn('[reconnect] REST fallback failed', executionId, err);
            });
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_started', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_started') return;
        // parentExecutionId identifies the direct parent; falls back to
        // executionId (top-level) for direct children where they're the same.
        const ctx = resolveParentContext(store().executions, msg.parentExecutionId ?? msg.executionId);
        if (!ctx) return;
        store().startChild(ctx.topLevelId, {
          childExecutionId: msg.childExecutionId,
          agentName: msg.agentName,
          model: msg.model,
          thoroughness: msg.thoroughness,
          maxIterations: msg.maxIterations,
          isBackground: msg.isBackground,
          ancestorPath: ctx.ancestorPath,
        });
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_iteration_step', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_iteration_step') return;
        // Look up by childExecutionId so grandchild events route to the correct
        // node rather than always resolving from the top-level executionId.
        const found = findChildAnyDepth(store().executions, msg.childExecutionId);
        if (!found) return;
        store().appendChildIteration(
          found.topLevelId,
          msg.childExecutionId,
          { iteration: msg.iteration, step: msg.step, isComplete: false, receivedAt: Date.now() },
          found.ancestorPath
        );
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_text_delta', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_text_delta') return;
        const found = findChildAnyDepth(store().executions, msg.childExecutionId);
        if (!found) return;
        store().appendChildTextDelta(
          found.topLevelId,
          msg.childExecutionId,
          msg.iteration,
          msg.delta,
          found.ancestorPath
        );
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_progress', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_progress') return;
        const found = findChildAnyDepth(store().executions, msg.childExecutionId);
        if (!found) return;
        store().setChildProgress(found.topLevelId, msg.childExecutionId, msg.status, found.ancestorPath);
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_completed', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_completed') return;
        const found = findChildAnyDepth(store().executions, msg.childExecutionId);
        if (!found) return;
        // Snapshot the child BEFORE we mutate it; `completeChild` doesn't
        // touch `isBackground`, but reading the pre-mutation flag keeps this
        // resilient if that ever changes. Toast only for background runs
        // (foreground completions are already visible inline in the iteration
        // stream).
        const childRef = found.ancestorPath.reduce<Record<string, ChildExecution> | undefined>(
          (children, id) => children?.[id]?.childExecutions,
          store().executions[found.topLevelId]?.childExecutions
        )?.[msg.childExecutionId];
        const wasBackground = childRef?.isBackground;
        const agentName = childRef?.agentName ?? 'Subagent';
        store().completeChild(
          found.topLevelId,
          msg.childExecutionId,
          { totalCredits: msg.totalCredits, iterations: msg.iterations, finalAnswer: msg.finalAnswer },
          found.ancestorPath
        );
        if (wasBackground) {
          const sessionId = store().executions[found.topLevelId]?.sessionId;
          const childExecutionId = msg.childExecutionId;
          notifyBackgroundCompletion(agentName, msg.finalAnswer, () =>
            router.navigate({ to: AGENT_TRACE_ROUTE, search: buildAgentTraceSearch(childExecutionId, sessionId) })
          );
        }
      })
    );

    unsubscribers.push(
      subscribeToAction('subagent_failed', async (msg: IMessageDataToClient) => {
        if (msg.action !== 'subagent_failed') return;
        const found = findChildAnyDepth(store().executions, msg.childExecutionId);
        if (!found) return;
        const childRef = found.ancestorPath.reduce<Record<string, ChildExecution> | undefined>(
          (children, id) => children?.[id]?.childExecutions,
          store().executions[found.topLevelId]?.childExecutions
        )?.[msg.childExecutionId];
        const wasBackground = childRef?.isBackground;
        const agentName = childRef?.agentName ?? 'Subagent';
        store().failChild(
          found.topLevelId,
          msg.childExecutionId,
          { error: msg.error, isTimeout: msg.isTimeout, partialAnswer: msg.partialAnswer },
          found.ancestorPath
        );
        if (wasBackground) {
          // Distinct toast for failure path: same "background agent finished"
          // pattern, just with the error surfaced instead of an answer preview.
          // Still a launcher: a failed run persists its partial trace,
          // so "View trace" helps the user see where it broke.
          const sessionId = store().executions[found.topLevelId]?.sessionId;
          const childExecutionId = msg.childExecutionId;
          toast.error(`${agentName} (background) failed: ${msg.error}`, {
            duration: 8000,
            action: {
              label: 'View trace',
              onClick: () =>
                router.navigate({
                  to: AGENT_TRACE_ROUTE,
                  search: buildAgentTraceSearch(childExecutionId, sessionId),
                }),
            },
          });
        }
      })
    );

    return () => {
      for (const u of unsubscribers) u();
    };
  }, [subscribeToAction, queryClient]);
}

export function useAgentExecutionDispatch() {
  const { sendJsonMessage } = useWebsocket();

  return useMemo(
    () => ({
      start: (payload: Omit<AgentExecuteStart, 'action' | 'command'>) => {
        // Track the sessionId so the matching `execution_started` event can be
        // associated with it; the server doesn't echo sessionId back.
        useAgentExecutionStore.getState().registerPendingDispatch(payload.sessionId);
        // Cast: `agent_execute` isn't in MessageDataToServer (the server's own
        // Zod parser is the source of truth). Adding 4 variants under the same
        // `action` literal would break the outer discriminatedUnion.
        sendJsonMessage({ action: 'agent_execute', command: 'start', ...payload } as unknown as Parameters<
          typeof sendJsonMessage
        >[0]);
      },
      abort: (executionId: string) =>
        sendJsonMessage({ action: 'agent_execute', command: 'abort', executionId } as unknown as Parameters<
          typeof sendJsonMessage
        >[0]),
      respondToPermission: (executionId: string, toolName: string, approved: boolean, rememberForSession?: boolean) =>
        sendJsonMessage({
          action: 'agent_execute',
          command: 'permission_response',
          executionId,
          toolName,
          approved,
          rememberForSession,
        } as unknown as Parameters<typeof sendJsonMessage>[0]),
      reconnect: (sessionId?: string, executionId?: string) => {
        // Queue the sessionId so the matching `reconnect_result` can stamp it
        // onto the hydrated execution; the server response doesn't echo it
        // back (the payload shape stays stable). Skip queueing
        // when sessionId is absent (callers reconnecting by executionId
        // already know their target).
        if (sessionId) {
          useAgentExecutionStore.getState().registerPendingReconnect(sessionId);
        }
        sendJsonMessage({
          action: 'agent_execute',
          command: 'reconnect',
          sessionId,
          executionId,
        } as unknown as Parameters<typeof sendJsonMessage>[0]);
      },
    }),
    [sendJsonMessage]
  );
}
