/**
 * Tool Permission System
 *
 * Three-tier classification for agent tool execution:
 * 1. Allowed - the tool declares no side effect worth pausing for (see ToolSideEffects)
 * 2. Requires approval - tools with external side effects, and anything undeclared
 * 3. Remembered - an approval the user asked to keep survives the execution, because
 *    `approvedTools` / `deniedTools` are seeded from the per-user, per-session store
 *    (`sessionToolApprovalRepository`) when the execution is created.
 */

import type { GatedToolCall } from '@bike4mind/agents';
import { getToolSideEffects } from '@bike4mind/common';
import { isHeadlessConnection } from '@server/utils/headlessConnection';

export type ToolPermissionResult = 'allowed' | 'denied' | 'needs_approval';

/**
 * Classify whether a tool can be executed, needs approval, or is denied.
 *
 * Priority:
 * 1. Explicitly denied tools -> denied
 * 2. Explicitly approved tools -> allowed
 * 3. MCP tools (prefixed with mcp__) -> needs_approval regardless of any declaration:
 *    they are third-party and their risk is not knowable locally, so a declaration
 *    shipped alongside one would not be evidence of anything.
 * 4. Tools declaring `none` / `local` side effects -> allowed
 * 5. Everything else, including every undeclared tool -> needs_approval (safe default)
 *
 * Rule 4 is the inversion that matters: the classification lives next to the tool-name
 * enum in `@bike4mind/common` and is exhaustive over it, so a read-only tool is correct
 * the day it is added rather than the day someone notices it prompting in production.
 */
export function classifyToolPermission(
  toolName: string,
  approvedTools: string[],
  deniedTools: string[]
): ToolPermissionResult {
  if (deniedTools.includes(toolName)) {
    return 'denied';
  }

  if (approvedTools.includes(toolName)) {
    return 'allowed';
  }

  if (toolName.startsWith('mcp__')) {
    return 'needs_approval';
  }

  const sideEffects = getToolSideEffects(toolName);
  if (sideEffects === 'none' || sideEffects === 'local') {
    return 'allowed';
  }

  return 'needs_approval';
}

export type GatedAction = {
  toolName: string;
  toolInput: unknown;
  verdict: 'denied' | 'needs_approval';
  /**
   * Provider tool_use id. Always set by `selectGatedToolCall`, the only producer -
   * unlike `IPendingPermission.toolCallId`, which stays optional for pauses persisted
   * before the pre-execution gate existed.
   */
  toolCallId: string;
};

/**
 * True when a tool call must not run until the user says so - the predicate behind
 * `RunIterationOptions.toolGate`, which the agent consults BEFORE invoking the tool.
 * Withholding covers both `denied` and `needs_approval`: a denied tool must not run
 * either, and the executor re-reads the verdict from the withheld call to decide
 * between failing the run and asking.
 */
export function shouldWithholdToolCall(toolName: string, approvedTools: string[], deniedTools: string[]): boolean {
  return classifyToolPermission(toolName, approvedTools, deniedTools) !== 'allowed';
}

/**
 * Pick the verdict the executor acts on from the calls the gate withheld this
 * iteration. Same deterministic rule as the post-execution scan it replaced:
 * any `denied` call wins immediately, otherwise the first `needs_approval`.
 *
 * `pendingPermission` holds one toolName by design, so the remaining withheld calls
 * are persisted alongside it and re-selected on the next pause - a second gated tool
 * in the same iteration raises its own permission card after the first is settled.
 */
export function selectGatedToolCall(
  calls: GatedToolCall[],
  approvedTools: string[],
  deniedTools: string[]
): GatedAction | null {
  let firstNeedsApproval: GatedAction | null = null;

  for (const call of calls) {
    const verdict = classifyToolPermission(call.name, approvedTools, deniedTools);
    if (verdict === 'denied') {
      return { toolName: call.name, toolInput: call.input, verdict, toolCallId: call.id };
    }
    if (verdict === 'needs_approval' && !firstNeedsApproval) {
      firstNeedsApproval = { toolName: call.name, toolInput: call.input, verdict, toolCallId: call.id };
    }
  }

  return firstNeedsApproval;
}

/**
 * Partition an iteration's withheld calls into the ones a permission response just
 * approved and the ones still awaiting a verdict - the pure decision behind the
 * approve -> replay resume block in `agentExecutor.ts`.
 *
 * A call is "now approved" when it is the specific `tool_use` the card named
 * (matched by id, never by name - one iteration can withhold two calls to the same
 * tool with different arguments, and the card only ever showed the user one of
 * them), OR when the gate would no longer withhold it at all - that is how a
 * "remember for this session" approval (which widened `approvedTools`) covers the
 * rest of the batch in one response.
 */
export function partitionApprovedPause(
  withheld: GatedToolCall[],
  approvedToolCallId: string | undefined,
  approvedTools: string[],
  deniedTools: string[]
): { nowApproved: GatedToolCall[]; stillWithheld: GatedToolCall[] } {
  const nowApproved = withheld.filter(
    c => c.id === approvedToolCallId || !shouldWithholdToolCall(c.name, approvedTools, deniedTools)
  );
  const approvedIds = new Set(nowApproved.map(c => c.id));
  const stillWithheld = withheld.filter(c => !approvedIds.has(c.id));
  return { nowApproved, stillWithheld };
}

export type ResumeApprovedPauseOutcome =
  { status: 'replayed' } | { status: 'replay_error' } | { status: 'repaused' } | { status: 'unresolvable' };

/**
 * Replay an iteration's approved-and-withheld tool calls and settle whatever is left.
 * This is the whole approve -> replay state machine `agentExecutor.ts` pauses into and
 * resumes from - extracted so it is unit-testable end to end without a live executor.
 * Every side effect (replay, checkpoint write, billing, re-pause) lives here, including
 * the re-pause itself: `deps.settleGatedCall` is `agentExecutor.ts`'s thin wrapper over
 * this module's own `settleGatedCall`, so a second gated call re-runs the same tested
 * disposition logic rather than an opaque injected stand-in. The caller only decides
 * whether to keep running the iteration loop based on `status`.
 */
export async function resumeApprovedPause<TCheckpoint>(
  params: {
    executionId: string;
    iterationIndex: number;
    withheld: GatedToolCall[];
    approvedToolCallId: string | undefined;
    approvedTools: string[];
    deniedTools: string[];
  },
  deps: {
    executeGatedToolCall: (call: { id: string; name: string; input: unknown }) => Promise<unknown>;
    toCheckpoint: () => TCheckpoint;
    updatePermissionState: (executionId: string) => Promise<unknown>;
    updateCheckpoint: (executionId: string, checkpoint: TCheckpoint) => Promise<unknown>;
    billIterationIfNeeded: (iterationIndex: number, checkpoint: TCheckpoint) => Promise<void>;
    settleGatedCall: (gated: GatedAction, withheld: GatedToolCall[]) => Promise<void>;
    markFailed: (executionId: string, err: { message: string; callerSafe?: boolean }) => Promise<unknown>;
    sendWs: (event: string, payload: Record<string, unknown>) => Promise<void>;
    persistRunAsQuest: (message: string) => Promise<void>;
    logger: { error: (msg: string, meta?: Record<string, unknown>) => void };
  }
): Promise<ResumeApprovedPauseOutcome> {
  const { executionId, iterationIndex, withheld, approvedToolCallId, approvedTools, deniedTools } = params;
  const { nowApproved, stillWithheld } = partitionApprovedPause(
    withheld,
    approvedToolCallId,
    approvedTools,
    deniedTools
  );

  for (const call of nowApproved) {
    try {
      await deps.executeGatedToolCall({ id: call.id, name: call.name, input: call.input });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Deliberately does not claim the tool did not run: `executeGatedToolCall` refuses
      // before invoking the tool when it cannot record the result, but any other throw
      // here can land after the side effect.
      deps.logger.error('[Permission] Approved tool call could not be replayed', {
        executionId,
        call: call.name,
        errMsg,
      });
      await deps.markFailed(executionId, { message: `Approved tool "${call.name}" did not complete: ${errMsg}` });
      await deps.sendWs('failed', { executionId, reason: 'gated_replay_error', toolName: call.name });
      await deps.persistRunAsQuest(`Approved tool "${call.name}" did not complete.`);
      return { status: 'replay_error' };
    }
  }

  const replayCheckpoint = deps.toCheckpoint();
  await deps.updatePermissionState(executionId);
  await deps.updateCheckpoint(executionId, replayCheckpoint);
  // Settle the replayed tools' provider/LLM spend against the iteration that asked for
  // them. Deferring it to the next iteration's billing would drop it entirely when the
  // run exits the loop first (ceiling reached), and a provider was genuinely called.
  // The token delta is zero here, so this charges the tool spend and nothing else.
  await deps.billIterationIfNeeded(iterationIndex, replayCheckpoint);

  // Everything left is still withheld by construction, so this always selects - the run
  // must not fall through to the loop with a `GATED_TOOL_OBSERVATION` placeholder the
  // model would read as "awaiting approval" for the rest of the run.
  if (stillWithheld.length > 0) {
    // Defensive only: `stillWithheld` is built from calls where `shouldWithholdToolCall`
    // is true (see `partitionApprovedPause`), which is exactly `classifyToolPermission(...)
    // !== 'allowed'` - so `selectGatedToolCall` always returns non-null here. Kept as a
    // guard against the two functions' contracts drifting apart, not a reachable branch.
    const nextGated = selectGatedToolCall(stillWithheld, approvedTools, deniedTools);
    if (!nextGated) {
      deps.logger.error(
        '[Permission] Withheld calls remain but none classifies as gated - failing rather than stranding them',
        { executionId, tools: stillWithheld.map(c => c.name) }
      );
      await deps.markFailed(executionId, {
        message: 'Execution stopped: a tool call was left awaiting approval that can no longer be resolved.',
      });
      // Distinct from `gated_replay_error` (a replay throw): this is "no withheld call
      // classified as gated," never seen alongside a caught replay exception.
      await deps.sendWs('failed', { executionId, reason: 'gated_unresolvable' });
      await deps.persistRunAsQuest('Execution stopped: an approval could not be resolved.');
      return { status: 'unresolvable' };
    }
    await deps.settleGatedCall(nextGated, stillWithheld);
    return { status: 'repaused' };
  }

  return { status: 'replayed' };
}

export type ReplayConfidenceOutcome = { status: 'proceed' } | { status: 'paused' } | { status: 'aborted' };

/**
 * Apply the confidence gate to a batch of just-replayed approval calls, mirroring the
 * pause-for-review check `agentExecutor.ts` runs after every ordinary `runIteration()` -
 * see `ReActAgent.takeIterationConfidence` for why the replay path needs its own call
 * into the same decision instead of falling out of the regular post-iteration check.
 *
 * `confidence: null` means nothing was replayed (or nothing scored) - proceed without
 * touching the DB. A `confidenceGateThreshold` of 0 (an unattended-loop profile override)
 * always proceeds too, since a real confidence score is never negative.
 */
export async function gateReplayConfidence(
  params: {
    executionId: string;
    iterationIndex: number;
    confidence: number | null;
    confidenceGateThreshold: number;
  },
  deps: {
    recordIterationConfidence: (executionId: string, confidence: number) => Promise<void>;
    setPendingGate: (
      executionId: string,
      gate: { iteration: number; confidence: number; reason: string; requestedAt: Date }
    ) => Promise<boolean>;
    recordGateEmitted: (executionId: string) => Promise<void>;
    sendWs: (event: string, payload: Record<string, unknown>) => Promise<void>;
    logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  }
): Promise<ReplayConfidenceOutcome> {
  const { executionId, iterationIndex, confidence, confidenceGateThreshold } = params;
  if (confidence === null) return { status: 'proceed' };

  // Telemetry parity with the ordinary per-iteration gate check: every evaluated
  // iteration is recorded, not just the ones that pause.
  await deps.recordIterationConfidence(executionId, confidence);
  if (confidence >= confidenceGateThreshold) return { status: 'proceed' };

  // Same 0-indexed wire convention as `settleGatedCall`'s `permission_request` emit.
  const wireIteration = Math.max(0, iterationIndex - 1);
  const reason = `Iteration confidence ${(confidence * 100).toFixed(0)}% below threshold ${(confidenceGateThreshold * 100).toFixed(0)}%`;
  const gatePayload = { iteration: wireIteration, confidence, reason };
  deps.logger.info('[ConfidenceGate] Pausing execution for human review after a replayed approval', {
    executionId,
    ...gatePayload,
  });

  const paused = await deps.setPendingGate(executionId, { ...gatePayload, requestedAt: new Date() });
  if (!paused) {
    // Raced by a concurrent abort between the read that got us here and this write -
    // bail without overwriting the aborted doc, same as the ordinary gate check does.
    await deps.sendWs('failed', { executionId, reason: 'aborted' });
    return { status: 'aborted' };
  }
  await deps.recordGateEmitted(executionId);
  await deps.sendWs('confidence_gate', { executionId, ...gatePayload });
  await deps.sendWs('progress', { executionId, status: 'paused' });
  return { status: 'paused' };
}

/**
 * What the executor should do about a gated action.
 *
 * - `denied` - the tool is on the execution's deny list; fail the run.
 * - `no_approver` - the tool needs approval but the run has no WebSocket peer, so
 *   there is nobody to render a permission card and `permission_response` (a
 *   WebSocket-only command) can never arrive. Fail the run naming the tool.
 * - `ask` - pause in `awaiting_permission` and ask the client.
 */
export type GateDisposition = 'denied' | 'no_approver' | 'ask';

/**
 * Decide a gated action's fate from its verdict and whether the run has a live peer.
 *
 * Split out from the executor so the `no_approver` branch is testable on its own: it is
 * what keeps a REST-started run from parking in `awaiting_permission` until the
 * 20-minute stale sweep, holding one of the caller's concurrency slots the whole time -
 * and the caller cannot avoid it, because the AGENT chooses to call a gated tool. It
 * reads the sentinel itself rather than taking a boolean, so a dispatcher that stops
 * threading `connectionId` through cannot quietly reintroduce that wedge.
 *
 * "No approver" is treated as denial, the same fail-safe reading the deny list gets.
 */
export function resolveGateDisposition(verdict: GatedAction['verdict'], connectionId: string): GateDisposition {
  if (verdict === 'denied') return 'denied';
  return isHeadlessConnection(connectionId) ? 'no_approver' : 'ask';
}

/**
 * A gated tool call cannot coexist with a subagent/DAG handoff from the SAME turn.
 * `delegate_to_agent`/`coordinate_task` are exempt from the pre-execution gate (see
 * `agentExecutor.ts`'s `HANDOFF_DISPATCH_TOOLS`), so they already ran and set the
 * handoff signal - but nothing durable about that handoff exists until the branches
 * that act on the signal run, and a permission pause would skip straight past them
 * (it is checked first, see `agentExecutor.ts`). Pausing there would strand the
 * handoff while its already-dispatched children finish into a parent that never
 * learns about them, so the executor fails the run explicitly instead.
 *
 * Pure so the four cases are unit-testable without a live executor: no withheld
 * calls this turn is always `proceed` regardless of the signal, and a withheld call
 * alongside either handoff signal is always `conflict`.
 */
export function resolveHandoffConflict(withheldCount: number, hasHandoffSignal: boolean): 'conflict' | 'proceed' {
  return withheldCount > 0 && hasHandoffSignal ? 'conflict' : 'proceed';
}

/**
 * A pending permission as persisted on the execution doc, restated locally so this
 * module does not need to import the database model's type for one field shape.
 */
export type PendingPermissionUpdate = {
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
  gatedToolCalls: Array<{ id: string; name: string; input: unknown }>;
  requestedAt: Date;
};

export type SettleGatedCallOutcome = 'denied' | 'no_approver' | 'unsupported' | 'ask';

/**
 * Act on a withheld call: fail the run, or park it in `awaiting_permission` and ask
 * the client. Every outcome is terminal for the calling Lambda invocation, so the
 * caller returns right after. `withheld` carries the whole iteration's withheld set
 * so a second gated tool raises its own card once this one is settled.
 *
 * Extracted (deps-injected, no closure over a live executor) so all four
 * dispositions - `denied`, `no_approver`, `unsupported`, `ask` - are unit-testable.
 */
export async function settleGatedCall(
  params: {
    executionId: string;
    connectionId: string;
    gated: GatedAction;
    withheld: GatedToolCall[];
    iterationIndex: number;
  },
  deps: {
    // Only Anthropic / Bedrock-Anthropic / DeepSeek / OpenAI implement the backend
    // method a replay needs (`replaceLastToolResultObservation`) - on any other
    // backend a card here would offer an "Approve" whose only outcome is a failed
    // replay, so it is treated the same as `no_approver` instead.
    supportsGatedReplay: () => boolean;
    updateStatus: (executionId: string, status: 'awaiting_permission') => Promise<unknown>;
    updatePermissionState: (
      executionId: string,
      update: { pendingPermission: PendingPermissionUpdate }
    ) => Promise<unknown>;
    markFailed: (executionId: string, err: { message: string; callerSafe?: boolean }) => Promise<unknown>;
    sendWs: (event: string, payload: Record<string, unknown>) => Promise<void>;
    persistRunAsQuest: (message: string) => Promise<void>;
    logger: {
      warn: (msg: string, meta?: Record<string, unknown>) => void;
      info: (msg: string, meta?: Record<string, unknown>) => void;
    };
  }
): Promise<SettleGatedCallOutcome> {
  const { executionId, connectionId, gated, withheld, iterationIndex } = params;
  const { toolName, toolInput, verdict } = gated;
  const disposition = resolveGateDisposition(verdict, connectionId);

  if (disposition === 'denied') {
    deps.logger.warn(`[Permission] Tool "${toolName}" is denied - failing execution`);
    const deniedMessage = `Execution stopped: tool "${toolName}" is not permitted`;
    // `callerSafe`: this string names only a tool the caller already knows about, and
    // the public poll response is documented to name the gated tool - so it is
    // published verbatim rather than collapsed by the sanitizer.
    await deps.markFailed(executionId, { message: deniedMessage, callerSafe: true });
    await deps.sendWs('failed', { executionId, reason: 'tool_denied', toolName });
    // Settle the dispatch-time Quest so chat history shows the reason instead of a
    // permanently `pending` empty bubble - only `persistRunAsQuest` ever flips it to
    // `done`.
    await deps.persistRunAsQuest(`${deniedMessage}.`);
    return 'denied';
  }

  // A headless run (REST dispatch) has nobody to ask - see `resolveGateDisposition`
  // for why that is treated as denial rather than a pause.
  if (disposition === 'no_approver') {
    deps.logger.warn(`[Permission] Tool "${toolName}" needs approval but the run is headless - failing`, {
      executionId,
      toolName,
    });
    const headlessMessage =
      `Execution stopped: tool "${toolName}" requires approval, and this run was started ` +
      'without an interactive client to approve it. Re-run with a "tools" allowlist that ' +
      'excludes approval-gated tools, or start the run over the WebSocket route.';
    // `callerSafe`: written for the REST caller specifically - it names the gated tool
    // and the remedy, which is exactly what the contract promises in `error`.
    await deps.markFailed(executionId, { message: headlessMessage, callerSafe: true });
    await deps.persistRunAsQuest(`${headlessMessage}`);
    return 'no_approver';
  }

  if (!deps.supportsGatedReplay()) {
    deps.logger.warn(`[Permission] Tool "${toolName}" needs approval but the backend cannot replay it - failing`, {
      executionId,
      toolName,
    });
    const unsupportedMessage =
      `Execution stopped: tool "${toolName}" requires approval, but the current model does ` +
      'not support resuming after approval. Switch to a model that supports approval-gated ' +
      'tools, or remove this tool from the run.';
    await deps.markFailed(executionId, { message: unsupportedMessage, callerSafe: true });
    await deps.sendWs('failed', { executionId, reason: 'gated_replay_unsupported', toolName });
    await deps.persistRunAsQuest(`${unsupportedMessage}`);
    return 'unsupported';
  }

  deps.logger.info(`[Permission] Tool "${toolName}" needs approval, pausing before it runs`);
  await deps.updateStatus(executionId, 'awaiting_permission');
  await deps.updatePermissionState(executionId, {
    pendingPermission: {
      toolName,
      toolInput,
      toolCallId: gated.toolCallId,
      gatedToolCalls: withheld.map(c => ({ id: c.id, name: c.name, input: c.input })),
      requestedAt: new Date(),
    },
  });

  await deps.sendWs('permission_request', {
    executionId,
    toolName,
    toolInput,
    // 0-indexed to match per-step `iteration_step` events and the accordion labels in
    // `IterationStream` (which renders `Iteration {group.iteration + 1}`).
    // `iterationIndex` is the agent's 1-indexed `this.iterations` after the iteration
    // ran, so subtract 1 here so `PermissionCard`'s `pending.iteration + 1` display
    // lines up with the iteration the user is actually approving.
    iteration: Math.max(0, iterationIndex - 1),
    // The client echoes this back on `permission_response` - see
    // `handlePermissionResponse`'s toolCallId identity check.
    toolCallId: gated.toolCallId,
  });

  // Lambda exits - client sends permission_response via WebSocket, which
  // re-invokes this Lambda with ContinuationSchema.
  return 'ask';
}
