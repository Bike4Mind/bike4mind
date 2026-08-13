/**
 * Attaches a tool call's outcome onto its `toolsUsed` entry so it survives into
 * `promptMeta.functionCalls.returnValue`/`.success` (see ChatCompletionProcess.ts's mapper
 * and utils.ts's `replayableToolCalls`, which gates a whole replay path on at least one
 * recorded `returnValue`). Every backend pushes a `toolsUsed` entry before executing the
 * tool and only learns the real outcome a few lines later - this is the merge-back.
 */

/** Cap applied to a persisted `returnValue` before it reaches Mongo (chars, not bytes). */
export const MAX_RECORDED_TOOL_RESULT_CHARS = 8_000;

export const TOOL_RESULT_TRUNCATION_NOTICE = '\n[tool result truncated]';

export type RecordableToolUse = {
  name: string;
  arguments?: string;
  /** Tool use ID for Anthropic API tool pairing */
  id?: string;
  returnValue?: string;
  success?: boolean;
};

export function truncateToolResult(observation: string): string {
  if (observation.length <= MAX_RECORDED_TOOL_RESULT_CHARS) return observation;
  return observation.slice(0, MAX_RECORDED_TOOL_RESULT_CHARS) + TOOL_RESULT_TRUNCATION_NOTICE;
}

/**
 * Finds the NOT-YET-STAMPED `toolsUsed` entry for this call (id-first, falling back to the
 * first unstamped entry with the same name when a provider omitted an id) and attaches the
 * truncated result. The "not yet stamped" filter (`success === undefined`) is what keeps this
 * safe across recursive tool-call turns: `toolsUsed` accumulates across rounds, so a later
 * turn's call to the same tool must not overwrite an earlier turn's already-recorded entry.
 * Never throws - a call with no matching entry (e.g. one filtered out before execution) is a
 * silent no-op, matching the tolerance the existing normalize-by-id sites already have.
 */
export function recordToolResult(
  toolsUsed: RecordableToolUse[],
  call: { id?: string; name: string },
  observation: string,
  success: boolean
): void {
  const wantId = call.id || undefined;
  const entry = toolsUsed.find(
    t => t.success === undefined && t.name === call.name && (wantId === undefined || t.id === wantId)
  );
  if (!entry) return;
  entry.returnValue = truncateToolResult(String(observation));
  entry.success = success;
}
