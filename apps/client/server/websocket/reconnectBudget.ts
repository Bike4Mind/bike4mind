/**
 * Inline-vs-REST frame budgeting for the `reconnect_result` WS frame.
 *
 * Kept in its own dependency-free module so the budget contract is unit-testable
 * without standing up the full WebSocket handler (which imports SST `Resource`,
 * the database layer, and AWS SDK clients).
 */

/**
 * Inline step-replay budget for a single `reconnect_result` frame.
 * API Gateway WebSocket frames cap at 128KB; we cap the persisted steps array
 * at 100KB to leave headroom for the rest of the payload (status,
 * pendingPermission, tokens, JSON overhead). Anything larger sets
 * `stepsTruncated: true` and the client fetches the full trace via
 * `GET /api/agent-executions/[id]`.
 */
export const STEPS_INLINE_BUDGET_BYTES = 100 * 1024;

/**
 * Combined inline budget for `steps` + `children` in a single `reconnect_result`
 * frame. `steps` and `children` are sized independently, but they
 * ride in the *same* WS frame - so their individual budgets can't both be the
 * full 100KB or a steps=65KB + children=65KB run would assemble a ~130KB frame
 * and blow past API Gateway's 128KB hard cap (the frame is then silently
 * dropped and the client never re-hydrates). Cap the pair at 110KB, leaving
 * ~18KB for the envelope (status, pendingPermission, tokens, JSON overhead).
 * Whichever side doesn't fit the *remaining* budget falls back to REST.
 */
export const COMBINED_INLINE_BUDGET_BYTES = 110 * 1024;

/**
 * Decide which of `steps` / `children` ride inline in the `reconnect_result`
 * frame vs. fall back to REST, enforcing the combined frame budget.
 * Steps take priority (parent trace is the primary view); children get whatever
 * of the combined budget remains after steps.
 */
export function decideInlineBudgets(
  stepsJsonSize: number,
  childrenJsonSize: number
): { includeStepsInline: boolean; includeChildrenInline: boolean } {
  const includeStepsInline = stepsJsonSize <= STEPS_INLINE_BUDGET_BYTES;
  // Children get the combined budget minus whatever steps actually consume in
  // this frame (zero when steps are truncated out to REST).
  const childrenBudget = COMBINED_INLINE_BUDGET_BYTES - (includeStepsInline ? stepsJsonSize : 0);
  const includeChildrenInline = childrenJsonSize > 0 && childrenJsonSize <= childrenBudget;
  return { includeStepsInline, includeChildrenInline };
}
