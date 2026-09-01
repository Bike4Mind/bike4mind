/**
 * Tool Permission System
 *
 * Three-tier classification for agent tool execution:
 * 1. Always safe - read-only tools that can execute without approval
 * 2. Requires approval - tools with side effects that need user permission
 * 3. Session-rememberable - once approved, stored for the execution session
 */

import type { AgentStep } from '@bike4mind/agents';
import { isHeadlessConnection } from '@server/utils/headlessConnection';

// Tools that never require permission - not all strictly read-only, but none have
// an unreviewed side effect: `recharts` / `mermaid_chart` only emit an <artifact>
// block (no storage, no user-data mutation), and the OptiHashi tools only emit an
// /opti-gated __uiSideEffect the user can Undo. Same-risk tools must stay paired
// (see the inline notes), or agent mode would auto-run one while pausing its twin
// for approval.
const ALWAYS_SAFE_TOOLS = new Set([
  'web_search',
  'deep_research',
  'recharts',
  'mermaid_chart',
  'chess_engine',
  // All five OptiHashi tools share one risk surface: each invokes an LLM/solver and emits
  // only an /opti-gated __uiSideEffect the user can Undo - none mutates stored user data or
  // calls out externally (durable/hardware compute submission is separately flag-gated). They
  // must stay grouped so agent mode doesn't auto-run one while pausing its twin for approval,
  // AND so the autonomous decompose -> formulate -> schedule -> advance loop isn't interrupted
  // by an approval prompt at every step.
  'optihashi_decompose',
  'optihashi_formulate',
  'optihashi_edit_problem',
  'optihashi_schedule',
  'optihashi_solve',
]);

// Tools with side effects that always require first-time approval
const REQUIRES_APPROVAL_TOOLS = new Set([
  'send_slack_message',
  'delegate_to_agent',
  'image_generation',
  'edit_image',
  'music_generation',
  'audio_generation',
  'video_generation',
]);

export type ToolPermissionResult = 'allowed' | 'denied' | 'needs_approval';

/**
 * Classify whether a tool can be executed, needs approval, or is denied.
 *
 * Priority:
 * 1. Explicitly denied tools -> denied
 * 2. Explicitly approved tools -> allowed
 * 3. Always-safe tools -> allowed
 * 4. MCP tools (prefixed with mcp__) -> needs_approval (first time)
 * 5. Known side-effect tools -> needs_approval
 * 6. Unknown tools -> needs_approval (safe default)
 */
export function classifyToolPermission(
  toolName: string,
  approvedTools: string[],
  deniedTools: string[]
): ToolPermissionResult {
  // Explicitly denied - session-level denial
  if (deniedTools.includes(toolName)) {
    return 'denied';
  }

  // Explicitly approved - session-level approval
  if (approvedTools.includes(toolName)) {
    return 'allowed';
  }

  // Always-safe read-only tools
  if (ALWAYS_SAFE_TOOLS.has(toolName)) {
    return 'allowed';
  }

  // MCP tools always need first-time approval
  if (toolName.startsWith('mcp__')) {
    return 'needs_approval';
  }

  // Known side-effect tools need approval
  if (REQUIRES_APPROVAL_TOOLS.has(toolName)) {
    return 'needs_approval';
  }

  // Unknown tools default to needing approval (safe default)
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
