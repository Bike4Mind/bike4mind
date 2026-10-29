import type { IMessage } from '@bike4mind/common';
import { isToolChangeMessage } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { CURRENT_MODEL_DETAILS_TOOL_NAME } from './tools/implementation/currentModelDetails';
import type { DeferredToolGuidance } from './tools/ToolBuilder';

/**
 * Deferred tool loading for in-app chat. Anthropic renders `tools` ahead of `system`, so every
 * distinct optional tool set is its own cached head. A tool sent with `defer_loading: true` is left
 * out of that rendered prefix; a `tool_addition` system message placed in the history surfaces it
 * (and its guidance) at that position instead. The tools array still carries only the tools this
 * turn offers, so nothing the caller is not entitled to is ever declared, searchable or callable.
 */

/** Offered to every in-app turn, so they stay loaded: the head is shared only if this set is too. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([CURRENT_MODEL_DETAILS_TOOL_NAME]);

/** `requiresTool` marker on the change message, so a turn that continues without tools drops it. */
export const DEFERRED_TOOLS_MARKER = 'deferred_tools';

type ToolChangeContent = Array<
  { type: 'tool_addition'; tool: { type: 'tool_reference'; name: string } } | { type: 'text'; text: string }
>;

export type DeferredToolPlan = {
  tools: ICompletionOptionTools[];
  /** Null when nothing is deferred; the caller then sends the turn exactly as before. */
  changeMessage: IMessage | null;
  deferredToolNames: string[];
};

/**
 * Names of the offered tools that can be deferred this turn. Empty unless a core tool is also
 * offered: the API needs at least one loaded tool, and a head with no core tool is not shared anyway.
 */
export function selectDeferrableToolNames(offeredToolNames: readonly string[]): string[] {
  if (!offeredToolNames.some(name => CORE_TOOL_NAMES.has(name))) return [];
  return [...new Set(offeredToolNames.filter(name => !CORE_TOOL_NAMES.has(name)))].sort();
}

/**
 * Marks the tools named in `deferNames` (and deferrable) `defer_loading` and builds the system
 * message that adds them, with their guidance as text after the additions. Tool order and guidance
 * order are by name, so two turns with the same offer produce the same bytes.
 */
export function planDeferredTools(
  tools: readonly ICompletionOptionTools[],
  deferNames: ReadonlySet<string>,
  guidance: readonly DeferredToolGuidance[] = []
): DeferredToolPlan {
  const deferredToolNames = selectDeferrableToolNames(tools.map(tool => tool.toolSchema.name)).filter(name =>
    deferNames.has(name)
  );
  if (deferredToolNames.length === 0) return { tools: [...tools], changeMessage: null, deferredToolNames };

  const deferred = new Set(deferredToolNames);
  const plannedTools = tools.map(tool =>
    deferred.has(tool.toolSchema.name) ? { ...tool, toolSchema: { ...tool.toolSchema, defer_loading: true } } : tool
  );
  const guidanceText = guidance
    .filter(entry => deferred.has(entry.tool) && entry.text.trim() !== '')
    .sort((left, right) => (left.tool === right.tool ? 0 : left.tool < right.tool ? -1 : 1))
    .map(entry => entry.text)
    .join('\n\n');
  const content: ToolChangeContent = [
    ...deferredToolNames.map(name => ({
      type: 'tool_addition' as const,
      tool: { type: 'tool_reference' as const, name },
    })),
    ...(guidanceText ? [{ type: 'text' as const, text: guidanceText }] : []),
  ];
  const changeMessage: IMessage = {
    role: 'system',
    content: content as unknown as IMessage['content'],
    requiresTool: DEFERRED_TOOLS_MARKER,
  };
  return { tools: plannedTools, changeMessage, deferredToolNames };
}

const isTurn = (message: IMessage) => message.role === 'user' || message.role === 'assistant';

/**
 * Inserts the change message after the earliest user turn it may follow: one whose next turn is an
 * assistant turn, or the last user turn. Pinning it early keeps it inside the history the next turn
 * replays, so its tool definitions are read from the history cache rather than re-sent each turn.
 */
export function insertToolChangeMessage(messages: readonly IMessage[], changeMessage: IMessage | null): IMessage[] {
  if (!changeMessage) return [...messages];
  const turnIndexes = messages.flatMap((message, index) => (isTurn(message) ? [index] : []));
  let insertAfter = -1;
  for (let position = 0; position < turnIndexes.length; position++) {
    const index = turnIndexes[position];
    if (messages[index].role !== 'user') continue;
    const next = turnIndexes[position + 1];
    if (next === undefined || messages[next].role === 'assistant') {
      insertAfter = index;
      break;
    }
  }
  if (insertAfter < 0) return [...messages];
  return [...messages.slice(0, insertAfter + 1), changeMessage, ...messages.slice(insertAfter + 1)];
}

/**
 * The request shape for a hop whose model cannot take deferred tools: the change message is removed,
 * `defer_loading` is cleared, and its guidance comes back as an ordinary system message ahead of the
 * first turn. Identity when nothing was deferred.
 */
export function undoDeferredTools(
  messages: readonly IMessage[],
  tools: readonly ICompletionOptionTools[] | undefined
): { messages: IMessage[]; tools: ICompletionOptionTools[] | undefined } {
  const changeMessages = messages.filter(isToolChangeMessage);
  const restoredTools = tools?.map(tool => {
    if (tool.toolSchema.defer_loading === undefined) return tool;
    const { defer_loading: _deferLoading, ...toolSchema } = tool.toolSchema;
    return { ...tool, toolSchema };
  });
  if (changeMessages.length === 0) return { messages: [...messages], tools: restoredTools };

  const guidanceText = changeMessages
    .flatMap(message =>
      (message.content as unknown as ToolChangeContent).flatMap(block => (block.type === 'text' ? [block.text] : []))
    )
    .join('\n\n');
  const remaining = messages.filter(message => !isToolChangeMessage(message));
  if (!guidanceText) return { messages: remaining, tools: restoredTools };
  const firstTurn = remaining.findIndex(isTurn);
  const at = firstTurn < 0 ? remaining.length : firstTurn;
  const guidanceMessage: IMessage = { role: 'system', content: guidanceText, requiresTool: DEFERRED_TOOLS_MARKER };
  return { messages: [...remaining.slice(0, at), guidanceMessage, ...remaining.slice(at)], tools: restoredTools };
}
