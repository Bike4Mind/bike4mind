import type { IMessage } from '@bike4mind/common';
import { isToolChangeMessage } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { HistoryToolTurn } from '@bike4mind/utils';
import { CURRENT_MODEL_DETAILS_TOOL_NAME } from './tools/implementation/currentModelDetails';

/**
 * Deferred tool loading for in-app chat. Anthropic renders `tools` ahead of `system`, so every
 * distinct optional tool set is its own cached head. A tool sent with `defer_loading: true` is left
 * out of that rendered prefix; a `tool_addition` system message in the history surfaces it (and its
 * guidance) at that position instead. Changes are append-only: each tool is added after the turn
 * that first offered it and removed after the turn that stopped offering it, so a tool-set change
 * re-writes only from that turn on. Only tools the turn offers are callable; anything else in
 * `tools` is a deferred declaration that earlier references need, and refuses if called.
 */

/** Offered to every in-app turn, so they stay loaded: the head is shared only if this set is too. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([CURRENT_MODEL_DETAILS_TOOL_NAME]);

/** `requiresTool` marker on change messages, so a turn that continues without tools drops them. */
export const DEFERRED_TOOLS_MARKER = 'deferred_tools';

/**
 * Never added, so never callable. Any deferred tool changes the rendered head (measured live), so it
 * is always declared: a turn with no optional tools then shares the head of turns that have some.
 */
export const DEFERRED_ANCHOR_TOOL_NAME = 'deferred_tools_anchor';

const notAvailable = (name: string) => `The ${name} tool is not available in this conversation.`;

export const deferredAnchorTool = (): ICompletionOptionTools => ({
  toolSchema: {
    name: DEFERRED_ANCHOR_TOOL_NAME,
    description: 'Not available.',
    parameters: { type: 'object', properties: {} },
    defer_loading: true,
  },
  toolFn: async () => notAvailable(DEFERRED_ANCHOR_TOOL_NAME),
});

type ToolChangeBlock =
  | { type: 'tool_addition' | 'tool_removal'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'text'; text: string };

/** One change, placed after `after` (a history prompt) or, when null, after the current user message. */
export type ToolChange = { after: IMessage | null; added: string[]; removed: string[] };

export type ToolTimeline = {
  changes: ToolChange[];
  /** Every tool some change adds; their guidance rides with the addition. */
  everAdded: string[];
  /** Added at some point but not offered now: declared deferred so earlier references resolve. */
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
 * Replays each turn's offered tools (plus any it called) into the minimal additions and removals.
 * A turn with no record keeps the previous set. `exclude` drops tools that cannot be declared now,
 * which re-writes history from their first addition.
 */
export function planToolTimeline(
  history: readonly HistoryToolTurn[],
  currentOffered: readonly string[],
  exclude: ReadonlySet<string> = new Set()
): ToolTimeline {
  const changes: ToolChange[] = [];
  const everAdded = new Set<string>();
  let active = new Set<string>();
  const step = (after: IMessage | null, offered: Set<string>) => {
    const added = sorted([...offered].filter(name => !active.has(name)));
    const removed = sorted([...active].filter(name => !offered.has(name)));
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
    notOffered: sorted([...everAdded].filter(name => !current.has(name))),
  };
}

const isTurn = (message: IMessage) => message.role === 'user' || message.role === 'assistant';

/** A change may follow a user message only when the next turn is the assistant's, or nothing. */
function placeableAfter(messages: readonly IMessage[], index: number): boolean {
  if (index < 0 || messages[index].role !== 'user') return false;
  const next = messages.slice(index + 1).find(isTurn);
  return next === undefined || next.role === 'assistant';
}

function changeMessage(added: string[], removed: string[], guidance: ReadonlyMap<string, string>): IMessage {
  const reference = (type: 'tool_addition' | 'tool_removal') => (name: string) => ({
    type,
    tool: { type: 'tool_reference' as const, name },
  });
  const text = added
    .map(name => guidance.get(name)?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');
  const content: ToolChangeBlock[] = [
    ...removed.map(reference('tool_removal')),
    ...added.map(reference('tool_addition')),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
  return { role: 'system', content: content as unknown as IMessage['content'], requiresTool: DEFERRED_TOOLS_MARKER };
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
 * The tools for a deferred turn: offered optional tools marked deferred, the core tools loaded, the
 * removed tools declared deferred with a refusing toolFn, and the anchor.
 */
export function declareDeferredTools(
  offered: readonly ICompletionOptionTools[],
  removedDeclarations: readonly ICompletionOptionTools[] = []
): ICompletionOptionTools[] {
  const defer = (tool: ICompletionOptionTools) =>
    CORE_TOOL_NAMES.has(tool.toolSchema.name)
      ? tool
      : { ...tool, toolSchema: { ...tool.toolSchema, defer_loading: true } };
  return [
    ...offered.map(defer),
    ...removedDeclarations.map(tool => ({
      ...tool,
      toolSchema: { ...tool.toolSchema, defer_loading: true },
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
