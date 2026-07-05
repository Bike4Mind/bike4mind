/**
 * Build serialized snapshots of a parent execution's non-background subagent
 * children for replay/reconnect.
 *
 * Shared by:
 * - The WS `reconnect_result` handler - inlines snapshots when payload fits
 *   under the API Gateway frame budget.
 * - The `/api/agent-executions/[id]` REST endpoint - used by the "Show
 *   reasoning" disclosure on Quest bubbles and as the WS REST-fallback path
 *   when the WS frame budget was exceeded.
 *
 * Background children are deliberately excluded: they surface via the header
 * badge + completion toast, not the nested step renderer. Background
 * children also store their parent link in `spawnedByExecutionId` (not
 * `parentExecutionId`), so `findChildExecutions` already filters them out by
 * construction - this function is non-background by query, not by post-filter.
 */
import { agentExecutionRepository } from '@bike4mind/database';
import type { IAgentStep, ChildExecutionSnapshotSchema } from '@bike4mind/common';
import type { z } from 'zod';

/**
 * Wire shape of a serialized child snapshot. Derived from the Zod schema in
 * `@bike4mind/common` (the single source of truth) rather than hand-redeclared,
 * so a field added/removed on the schema is a compile error here and in the
 * client's `AgentExecutionChildSnapshot` - the drift that let `isTimeout` go
 * unpopulated can't recur silently.
 */
export type ChildExecutionSnapshot = z.infer<typeof ChildExecutionSnapshotSchema>;

/**
 * Narrowing of `IAgentExecution.result` (typed `unknown` on the model because
 * the doc stores arbitrary serialized state). The persisted shape - set by
 * `agentExecutionRepository.markComplete` - has `answer` (not the agents-package
 * `AgentResult.finalAnswer`), so we narrow to what we actually write rather
 * than the in-memory `AgentResult` type. Same reasoning for `PersistedCheckpoint`.
 */
type PersistedResult = { answer?: string; steps?: IAgentStep[]; totalIterations?: number };
type PersistedCheckpoint = { steps?: IAgentStep[]; iteration?: number };

export async function buildChildExecutionSnapshots(
  parentExecutionId: string,
  _visited: Set<string> = new Set()
): Promise<ChildExecutionSnapshot[]> {
  // Guard against corrupted DB docs where a descendant points back to an ancestor,
  // which would cause unbounded recursion.
  if (_visited.has(parentExecutionId)) return [];
  const visited = new Set([..._visited, parentExecutionId]);
  const children = await agentExecutionRepository.findChildExecutions(parentExecutionId);
  return Promise.all(
    children.map(async child => {
      // Steps source priority: `result.steps` (set on terminal `markComplete`)
      // is the canonical post-completion trace; `checkpoint.steps` is the
      // mid-flight fallback for Lambda-dispatched children (in-process children
      // don't write checkpoints, so they show empty until their parent marks
      // them complete - that's expected and SubagentStepNest renders the agent
      // header alone in that case).
      const result = child.result as PersistedResult | null | undefined;
      const checkpoint = child.checkpoint as PersistedCheckpoint | null | undefined;
      // `subagentConfig` and `error` are typed on `IAgentExecution` - use the
      // model's own types directly so a model-side rename is a compile error here.
      const { subagentConfig, error } = child;
      // `error.timedOut` is the typed signal persisted by the live failure paths
      // in `agentExecutor.ts`. Legacy docs written before that field
      // existed leave it `undefined`, in which case we surface `undefined` -
      // "not known to be a timeout" - rather than guessing from the message text.
      const isTimeout = error?.timedOut;
      // Recurse into this child's own children (grandchildren of the original
      // parent) so the replay path shows the full nesting tree, not just the
      // first level.
      const grandchildren = await buildChildExecutionSnapshots(child.id, visited);
      return {
        executionId: child.id,
        // `subagentConfig.agentName` is persisted at creation time for every
        // subagent child (see `agentExecutor.ts` `onStart`). Fallback covers
        // legacy docs written before that change landed.
        agentName: subagentConfig?.agentName ?? 'Subagent',
        model: child.model,
        status: child.status,
        steps: result?.steps ?? checkpoint?.steps ?? [],
        totalCredits: child.totalCreditsUsed,
        finalAnswer: result?.answer,
        // Surface a generic error string only - raw `Error.message` may carry
        // stack fragments or internal paths. The client renders this verbatim
        // in the failed-subagent label; the server-side message is preserved on
        // the doc for audit.
        error: error?.message ? 'Subagent execution failed' : undefined,
        isTimeout,
        ...(grandchildren.length > 0 ? { children: grandchildren } : {}),
      };
    })
  );
}
