import type { ToolChangeBlock } from './schemas/cliCompletions';

/**
 * Deferred tool loading, the parts every caller shares (in-app chat in services, Desktop through
 * `/api/ai/v1/completions`). Anthropic renders `tools` ahead of `system`, so each distinct loaded
 * tool set is its own cached head. Optional tools go out with `defer_loading: true`, which keeps
 * them out of that head, and a `tool_addition` system message surfaces each one where it was first
 * offered, so a tool-set change re-writes only from that point on.
 */

/**
 * Declared deferred on every deferred request and never added, so never callable. Any deferred
 * tool changes the rendered head (measured live), so declaring this one always makes a turn with
 * no optional tools share the head of turns that have some.
 */
export const DEFERRED_ANCHOR_TOOL_NAME = 'deferred_tools_anchor';

export const DEFERRED_ANCHOR_TOOL_SCHEMA = {
  name: DEFERRED_ANCHOR_TOOL_NAME,
  description: 'Not available.',
  parameters: { type: 'object' as const, properties: {} },
  defer_loading: true,
};

const byCodeUnit = (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1);

/** What moves `active` to `next`, each list sorted by name so equal changes are equal bytes. */
export function diffToolNames(
  active: Iterable<string>,
  next: Iterable<string>
): { added: string[]; removed: string[] } {
  const from = new Set(active);
  const to = new Set(next);
  return {
    added: [...to].filter(name => !from.has(name)).sort(byCodeUnit),
    removed: [...from].filter(name => !to.has(name)).sort(byCodeUnit),
  };
}

/** The content of a tool change message: removals, then additions. No text, which the public proxy refuses. */
export function toolChangeContent(added: readonly string[], removed: readonly string[]): ToolChangeBlock[] {
  const reference = (type: ToolChangeBlock['type']) => (name: string) => ({
    type,
    tool: { type: 'tool_reference' as const, name },
  });
  return [...removed.map(reference('tool_removal')), ...added.map(reference('tool_addition'))];
}

/**
 * Whether a tool change message may go right after `messages[index]`: that message is a user turn
 * (a tool_result turn counts) and the message after it, if any, is an assistant turn.
 */
export function canFollowWithToolChange(messages: readonly { role: string }[], index: number): boolean {
  if (index < 0 || index >= messages.length || messages[index].role !== 'user') return false;
  const next = messages[index + 1];
  return next === undefined || next.role === 'assistant';
}
