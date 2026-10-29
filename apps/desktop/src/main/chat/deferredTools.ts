import {
  DEFERRED_ANCHOR_TOOL_SCHEMA,
  ModelBackend,
  canFollowWithToolChange,
  completionsSupportsToolChanges,
  completionsSupportsToolSearch,
  diffToolNames,
  toolChangeContent,
} from '@bike4mind/common';
import type { ChatMessage, ChatModelOption, ChatToolState } from '@shared/chat';
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@shared/webSearch';
import type { CompletionMessage } from './completions';
import type { ToolSchema } from './tools/types';

/**
 * Deferred tools for Desktop turns (the shared rules are in @bike4mind/common deferredTools.ts).
 *
 * The core tools stay loaded; every other offered tool goes out `defer_loading: true` and is
 * surfaced by a `tool_addition` message right after the user turn that first offered it. That turn
 * also carries the tool and folder guidance as a reminder (ChatMessage.toolState), because the
 * completions proxy refuses text in a tool change message. A later change to tools, folders or MCP
 * servers adds a new record on its own turn, so the system prompt and the history before it never
 * move.
 */

/** Offered on every signed-in remote turn, so the loaded set never changes. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]);

export type WireTool = { toolSchema: ToolSchema & { defer_loading?: boolean } };

/**
 * Whether `/api/ai/v1/completions` takes deferred tools and tool change messages for this model.
 * Direct Anthropic only: Bedrock refuses tool change messages, and a deferred tool nobody adds is
 * not callable, so a Bedrock turn keeps today's shape.
 */
export function supportsDeferredTools(model: ChatModelOption | undefined): boolean {
  if (!model || model.backend !== ModelBackend.Anthropic) return false;
  const capability = { id: model.id, backend: ModelBackend.Anthropic };
  return completionsSupportsToolChanges(capability) && completionsSupportsToolSearch(capability);
}

/** Every core tool is offered, which deferral needs: the API wants at least one loaded tool. */
export function offersCoreTools(tools: readonly WireTool[]): boolean {
  const names = new Set(tools.map(tool => tool.toolSchema.name));
  return [...CORE_TOOL_NAMES].every(name => names.has(name));
}

export function optionalToolNames(tools: readonly WireTool[]): string[] {
  return [...new Set(tools.map(tool => tool.toolSchema.name).filter(name => !CORE_TOOL_NAMES.has(name)))].sort();
}

export function sameToolState(left: ChatToolState | undefined, right: ChatToolState): boolean {
  return !!left && left.text === right.text && left.tools.join('\n') === right.tools.join('\n');
}

/**
 * The tools one deferred request declares: the offered core tools loaded, every other offered tool
 * deferred, the tools earlier records added but this turn no longer offers deferred (so their
 * additions and removals still resolve), and the never-added anchor.
 */
export function declareDeferredTools(offered: readonly WireTool[], withdrawn: readonly ToolSchema[]): WireTool[] {
  const offeredNames = new Set(offered.map(tool => tool.toolSchema.name));
  return [
    ...offered.map(tool =>
      CORE_TOOL_NAMES.has(tool.toolSchema.name) ? tool : { toolSchema: { ...tool.toolSchema, defer_loading: true } }
    ),
    ...withdrawn
      .filter(schema => !offeredNames.has(schema.name))
      .map(schema => ({ toolSchema: { ...schema, defer_loading: true } })),
    { toolSchema: DEFERRED_ANCHOR_TOOL_SCHEMA },
  ];
}

const sortedUnion = (...lists: (readonly string[])[]) => [...new Set(lists.flat())].sort();

function calledAfter(messages: readonly ChatMessage[], index: number, declarable: (name: string) => boolean): string[] {
  return messages
    .slice(index + 1)
    .flatMap(message => message.toolCalls ?? [])
    .map(call => call.name)
    .filter(name => !CORE_TOOL_NAMES.has(name) && declarable(name));
}

/**
 * The records to store before this turn's request is built, from the replayed history and the
 * state now. A conversation with none yet gets its first on its first user turn, with every tool
 * its history already called, so no replayed tool_use comes before that tool's addition.
 */
export function toolStateRecords(
  history: readonly ChatMessage[],
  current: ChatToolState,
  declarable: (name: string) => boolean
): { messageId: string; state: ChatToolState }[] {
  const userIndexes = history.flatMap((message, index) =>
    message.role === 'user' && !message.boundary ? [index] : []
  );
  if (userIndexes.length === 0) return [];
  const lastIndex = userIndexes[userIndexes.length - 1];
  const latestIndex = [...userIndexes].reverse().find(index => history[index].toolState);
  const atLast: ChatToolState = {
    tools: sortedUnion(current.tools, calledAfter(history, lastIndex, declarable)),
    text: current.text,
  };

  if (latestIndex === undefined) {
    const firstIndex = userIndexes[0];
    const first: ChatToolState = {
      tools: sortedUnion(current.tools, calledAfter(history, firstIndex, declarable)),
      text: current.text,
    };
    const records = [{ messageId: history[firstIndex].id, state: first }];
    if (firstIndex !== lastIndex && !sameToolState(first, atLast)) {
      records.push({ messageId: history[lastIndex].id, state: atLast });
    }
    return records;
  }
  const latest = history[latestIndex].toolState;
  if (latestIndex === lastIndex) {
    return sameToolState(latest, atLast) ? [] : [{ messageId: history[lastIndex].id, state: atLast }];
  }
  return sameToolState(latest, current) ? [] : [{ messageId: history[lastIndex].id, state: atLast }];
}

export function toolStateReminder(state: ChatToolState): string {
  return ['<system-reminder>', state.text, '</system-reminder>'].join('\n');
}

/** Where a replayed record sits on the wire: the index of the user message that carries it. */
export interface ToolStateMark {
  index: number;
  tools: readonly string[];
}

/**
 * Insert the tool change messages for the replayed records. A record whose turn cannot be followed
 * by a change (a user turn answered by another user turn) moves to the next place that can, and a
 * later record at the same place supersedes it. Names with no schema left are dropped, which
 * re-writes history from their first addition. Returns the names the changes reference, which the
 * request must declare.
 */
export function insertToolChanges(
  wire: readonly CompletionMessage[],
  marks: readonly ToolStateMark[],
  declarable: (name: string) => boolean
): { wire: CompletionMessage[]; referenced: string[] } {
  const placed = new Map<number, readonly string[]>();
  for (const mark of marks) {
    let at = mark.index;
    while (at < wire.length && !canFollowWithToolChange(wire, at)) at++;
    if (at < wire.length) placed.set(at, mark.tools.filter(declarable));
  }
  const inserts = new Map<number, CompletionMessage>();
  const referenced = new Set<string>();
  let active: readonly string[] = [];
  for (const [at, tools] of [...placed.entries()].sort(([left], [right]) => left - right)) {
    const { added, removed } = diffToolNames(active, tools);
    if (added.length > 0 || removed.length > 0) {
      inserts.set(at, { role: 'system', content: toolChangeContent(added, removed) });
    }
    [...added, ...removed].forEach(name => referenced.add(name));
    active = tools;
  }
  return {
    wire: wire.flatMap((message, index) => {
      const insert = inserts.get(index);
      return insert ? [message, insert] : [message];
    }),
    referenced: [...referenced].sort(),
  };
}

/**
 * A change in the middle of a turn: the reminder joins the newest user turn and the change message
 * goes last, so the next round's assistant turn follows it. In place, on this turn's wire only.
 */
export function appendLiveToolChange(wire: CompletionMessage[], from: readonly string[], to: ChatToolState): void {
  const reminder = toolStateReminder(to);
  for (let i = wire.length - 1; i >= 0; i -= 1) {
    const message = wire[i];
    if (message.role !== 'user') continue;
    wire[i] = {
      ...message,
      content:
        typeof message.content === 'string'
          ? `${message.content}\n\n${reminder}`
          : [...message.content, { type: 'text', text: reminder }],
    };
    break;
  }
  const { added, removed } = diffToolNames(from, to.tools);
  if (added.length > 0 || removed.length > 0) wire.push({ role: 'system', content: toolChangeContent(added, removed) });
}
