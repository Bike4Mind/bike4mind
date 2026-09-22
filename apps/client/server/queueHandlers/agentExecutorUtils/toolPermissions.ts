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
 * `AgentRunOptions.toolGate`, which the agent consults BEFORE invoking the tool.
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
 * Every side effect (replay, checkpoint write, billing, re-pause) lives here; the caller
 * only decides whether to keep running the iteration loop based on `status`.
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
    const nextGated = selectGatedToolCall(stillWithheld, approvedTools, deniedTools);
    if (!nextGated) {
      deps.logger.error(
        '[Permission] Withheld calls remain but none classifies as gated - failing rather than stranding them',
        { executionId, tools: stillWithheld.map(c => c.name) }
      );
      await deps.markFailed(executionId, {
        message: 'Execution stopped: a tool call was left awaiting approval that can no longer be resolved.',
      });
      await deps.sendWs('failed', { executionId, reason: 'gated_replay_error' });
      await deps.persistRunAsQuest('Execution stopped: an approval could not be resolved.');
      return { status: 'unresolvable' };
    }
    await deps.settleGatedCall(nextGated, stillWithheld);
    return { status: 'repaused' };
  }

  return { status: 'replayed' };
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
