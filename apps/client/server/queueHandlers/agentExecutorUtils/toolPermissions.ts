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

import type { AgentStep } from '@bike4mind/agents';
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
};

/**
 * Scan an iteration's steps for the most-restrictive permission verdict.
 *
 * `ReActAgent.runIteration()` returns the iteration's *primary* step (final_answer
 * or last step), which for a tool-calling iteration is the `observation` - not the
 * `action`. Inspecting only the primary step misses every tool call. This helper
 * walks `allSteps` instead.
 *
 * Multi-tool iterations (parallel execution) can call several tools at once.
 * `pendingPermission` is single-toolName by design, so we pick deterministically:
 * any `denied` action wins immediately; otherwise the first `needs_approval`.
 *
 * Returns null when no action requires gating.
 */
export function selectGatedAction(
  steps: AgentStep[],
  approvedTools: string[],
  deniedTools: string[]
): GatedAction | null {
  let firstNeedsApproval: GatedAction | null = null;

  for (const step of steps) {
    if (step.type !== 'action' || !step.metadata?.toolName) continue;
    const toolName = step.metadata.toolName;
    const verdict = classifyToolPermission(toolName, approvedTools, deniedTools);
    if (verdict === 'denied') {
      return { toolName, toolInput: step.metadata.toolInput, verdict };
    }
    if (verdict === 'needs_approval' && !firstNeedsApproval) {
      firstNeedsApproval = { toolName, toolInput: step.metadata.toolInput, verdict };
    }
  }

  return firstNeedsApproval;
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
