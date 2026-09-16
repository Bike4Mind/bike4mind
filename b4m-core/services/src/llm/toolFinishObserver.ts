/**
 * Tool-finish observer (host seam).
 *
 * Deliberately dependency-free. The host registers its observer from
 * apps/client's baseApi middleware, which every API route imports, so this
 * module must not reach the tool registry (llm/tools/index.ts) -- @vercel/nft
 * would then trace every tool implementation into all ~790 route bundles.
 * Keep it a leaf: no imports, and callers reach it via
 * '@bike4mind/services/llm/toolFinishObserver', never via the ./llm barrel.
 * See services/src/index.closure.test.ts.
 */

export interface ToolFinishObservation {
  toolName: string;
  userId?: string;
}

type ToolFinishObserver = (observation: ToolFinishObservation) => void;

let toolFinishObserver: ToolFinishObserver | null = null;

/**
 * Registers the single host observer called after ANY tool completes on the
 * shared pipeline (chat, agents, quests). Pass null to clear.
 */
export function setToolFinishObserver(observer: ToolFinishObserver | null): void {
  toolFinishObserver = observer;
}

/**
 * Fire-and-forget by contract: invoked synchronously, never awaited, and
 * exceptions are swallowed here so an observer can never add latency to or
 * break a tool call.
 */
export function notifyToolFinish(observation: ToolFinishObservation): void {
  if (!toolFinishObserver) return;
  try {
    toolFinishObserver(observation);
  } catch {
    // observers must never break or slow a tool call
  }
}
