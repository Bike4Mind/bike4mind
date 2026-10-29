import type { IMessage } from '@bike4mind/common';
import {
  canFollowWithToolChange,
  DEFERRED_ANCHOR_TOOL_NAME,
  DEFERRED_ANCHOR_TOOL_SCHEMA,
  diffToolNames,
  isToolChangeMessage,
  toolChangeContent,
} from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { HistoryToolTurn } from '@bike4mind/utils';
import { CURRENT_MODEL_DETAILS_TOOL_NAME } from './tools/implementation/currentModelDetails';

/**
 * Deferred tool loading for in-app chat, on the shared helpers in @bike4mind/common deferredTools.ts
 * (also used by Desktop). The conversation's start set stays loaded (startToolNames); every other
 * tool is added after the turn that first offered it and removed after the turn that stopped
 * offering it, with its guidance as a text block in the same message. Only
 * tools the turn offers are callable; anything else in `tools` is a deferred declaration that
 * earlier references need, and refuses if called.
 */

/** Offered to every in-app turn, so they stay loaded: the head is shared only if this set is too. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([CURRENT_MODEL_DETAILS_TOOL_NAME]);

/** `requiresTool` marker on change messages, so a turn that continues without tools drops them. */
export const DEFERRED_TOOLS_MARKER = 'deferred_tools';

const notAvailable = (name: string) => `The ${name} tool is not available in this conversation.`;

export const deferredAnchorTool = (): ICompletionOptionTools => ({
  toolSchema: { ...DEFERRED_ANCHOR_TOOL_SCHEMA },
  toolFn: async () => notAvailable(DEFERRED_ANCHOR_TOOL_NAME),
});

/** One change, placed after `after` (a history prompt) or, when null, after the current user message. */
export type ToolChange = { after: IMessage | null; added: string[]; removed: string[] };

export type ToolTimeline = {
  changes: ToolChange[];
  /** Every tool some change adds; their guidance rides with the addition. */
  everAdded: string[];
  /** Active from the start and declared loaded on every turn (see startToolNames). */
  loaded: ReadonlySet<string>;
  /** Loaded or added at some point but not offered now: declared so earlier references resolve. */
  notOffered: string[];
};

/** Deferral needs one loaded tool, and a head without the core tools is not shared anyway. */
export function hasCoreTool(offeredToolNames: readonly string[]): boolean {
  return offeredToolNames.some(name => CORE_TOOL_NAMES.has(name));
}

const deferrable = (names: Iterable<string>, exclude: ReadonlySet<string>) =>
  new Set(
    [...names].filter(name => !CORE_TOOL_NAMES.has(name) && name !== DEFERRED_ANCHOR_TOOL_NAME && !exclude.has(name))
  );

const sorted = (names: Iterable<string>) => [...names].sort();

/**
 * The optional tools a conversation keeps loaded: the shared ones (`isShared`, never per-user MCP
 * tools) its first recorded turn offered, or this turn's on a new chat. Fixed per conversation, so
 * its head is the per-tool-set head today's shape caches, warm at scale. Later changes go through
 * tool change messages, so they never rewrite the conversation.
 */
export function startToolNames(
  history: readonly HistoryToolTurn[],
  currentOffered: readonly string[],
  isShared: (name: string) => boolean
): string[] {
  const first = history.find(turn => turn.offeredTools)?.offeredTools ?? currentOffered;
  return sorted([...deferrable(first, new Set())].filter(isShared));
}

/** Rough token count of tool definitions: JSON schemas run about 3 characters per token. */
export function estimateToolDefinitionTokens(tools: readonly ICompletionOptionTools[]): number {
  return Math.ceil(tools.reduce((total, tool) => total + JSON.stringify(tool.toolSchema).length, 0) / 3);
}

/**
 * Replays each turn's offered tools (plus any it called) into the minimal additions and removals,
 * starting from the `loaded` set. A turn with no record keeps the previous set. `exclude` drops tools
 * that cannot be declared now, which re-writes history from their first addition (or, for a loaded
 * tool, changes the head).
 */
export function planToolTimeline(
  history: readonly HistoryToolTurn[],
  currentOffered: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
  loaded: ReadonlySet<string> = new Set()
): ToolTimeline {
  const changes: ToolChange[] = [];
  const everAdded = new Set<string>();
  const start = deferrable(loaded, exclude);
  let active = start;
  const step = (after: IMessage | null, offered: Set<string>) => {
    const { added, removed } = diffToolNames(active, offered);
    if (added.length > 0 || removed.length > 0) changes.push({ after, added, removed });
    added.forEach(name => everAdded.add(name));
    active = offered;
  };
  for (const turn of history) {
    if (!turn.offeredTools) continue;
    step(turn.prompt, deferrable([...turn.offeredTools, ...turn.calledTools], exclude));
  }
  const current = deferrable(currentOffered, exclude);
  step(null, current);
  return {
    changes,
    everAdded: sorted(everAdded),
    loaded: start,
    notOffered: sorted([...new Set([...start, ...everAdded])].filter(name => !current.has(name))),
  };
}

const isTurn = (message: IMessage) => message.role === 'user' || message.role === 'assistant';

/** Plain system messages are hoisted out by the adapter, so placement is judged on the turns alone. */
function placeableAfter(messages: readonly IMessage[], index: number): boolean {
  if (index < 0) return false;
  const turns = messages.filter(isTurn);
  return canFollowWithToolChange(turns, turns.indexOf(messages[index]));
}

function changeMessage(added: string[], removed: string[], guidance: ReadonlyMap<string, string>): IMessage {
  const text = added
    .map(name => guidance.get(name)?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');
  const content = [...toolChangeContent(added, removed), ...(text ? [{ type: 'text' as const, text }] : [])];
  return { role: 'system', content: content as unknown as IMessage['content'], requiresTool: DEFERRED_TOOLS_MARKER };
}

/**
 * The previous request's history breakpoint (the message before the last replayed prompt), when a
 * change sits after that prompt. The API looks back only 20 blocks from a breakpoint for an earlier
 * entry, and one tool_addition block per tool can push that entry out of reach (measured live), so
 * the caller marks this message too and reads it exactly.
 */
export function lookbackAnchor(
  history: readonly IMessage[],
  lastPrompt: IMessage | undefined,
  changes: readonly ToolChange[]
): IMessage | undefined {
  if (!lastPrompt || !changes.some(change => change.after === lastPrompt)) return undefined;
  const index = history.indexOf(lastPrompt);
  return index > 0 ? history[index - 1] : undefined;
}

/**
 * Inserts each change after its turn. A change whose turn is missing (an overflow rebuild makes new
 * message objects) or unplaceable is carried into the next one, so the net effect is unchanged.
 */
export function applyToolTimeline(
  messages: readonly IMessage[],
  changes: readonly ToolChange[],
  guidance: ReadonlyMap<string, string> = new Map()
): IMessage[] {
  const lastUser = messages.map(message => message.role).lastIndexOf('user');
  const inserts = new Map<number, IMessage>();
  const free = (index: number) => placeableAfter(messages, index) && !inserts.has(index);
  const added = new Set<string>();
  const removed = new Set<string>();
  changes.forEach((change, position) => {
    for (const name of change.removed) {
      if (!added.delete(name)) removed.add(name);
    }
    for (const name of change.added) {
      if (!removed.delete(name)) added.add(name);
    }
    const index = change.after ? messages.indexOf(change.after) : lastUser;
    const at = free(index) ? index : position === changes.length - 1 && free(lastUser) ? lastUser : -1;
    if (at < 0) return;
    if (added.size > 0 || removed.size > 0) inserts.set(at, changeMessage(sorted(added), sorted(removed), guidance));
    added.clear();
    removed.clear();
  });
  return messages.flatMap((message, index) => {
    const insert = inserts.get(index);
    return insert ? [message, insert] : [message];
  });
}

/**
 * The tools for a deferred turn: the core and `loaded` tools loaded, other offered tools deferred,
 * the removed tools declared (loaded ones stay loaded so the head keeps its bytes) with a refusing
 * toolFn, and the anchor.
 */
export function declareDeferredTools(
  offered: readonly ICompletionOptionTools[],
  removedDeclarations: readonly ICompletionOptionTools[] = [],
  loaded: ReadonlySet<string> = new Set()
): ICompletionOptionTools[] {
  const defer = (tool: ICompletionOptionTools) =>
    CORE_TOOL_NAMES.has(tool.toolSchema.name) || loaded.has(tool.toolSchema.name)
      ? tool
      : { ...tool, toolSchema: { ...tool.toolSchema, defer_loading: true } };
  return [
    ...offered.map(defer),
    ...removedDeclarations.map(tool => ({
      ...defer(tool),
      toolFn: async () => notAvailable(tool.toolSchema.name),
    })),
    deferredAnchorTool(),
  ];
}

/**
 * The request shape for a hop that cannot take deferred tools: change messages removed, declared-only
 * tools dropped, `defer_loading` cleared, and the offered tools' guidance back as a system message
 * ahead of the first turn. Identity (as copies) when nothing was deferred.
 */
export function undoDeferredTools(
  messages: readonly IMessage[],
  tools: readonly ICompletionOptionTools[] | undefined,
  { declaredOnly, guidance }: { declaredOnly: ReadonlySet<string>; guidance: string }
): { messages: IMessage[]; tools: ICompletionOptionTools[] | undefined } {
  const restoredTools = tools
    ?.filter(tool => !declaredOnly.has(tool.toolSchema.name))
    .map(tool => {
      if (tool.toolSchema.defer_loading === undefined) return tool;
      const { defer_loading: _deferLoading, ...toolSchema } = tool.toolSchema;
      return { ...tool, toolSchema };
    });
  const remaining = messages.filter(message => !isToolChangeMessage(message));
  if (remaining.length === messages.length || !guidance.trim()) return { messages: remaining, tools: restoredTools };
  const firstTurn = remaining.findIndex(isTurn);
  const at = firstTurn < 0 ? remaining.length : firstTurn;
  const guidanceMessage: IMessage = { role: 'system', content: guidance, requiresTool: DEFERRED_TOOLS_MARKER };
  return { messages: [...remaining.slice(0, at), guidanceMessage, ...remaining.slice(at)], tools: restoredTools };
}
