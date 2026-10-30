import type { ChatMessage, ChatSession } from '@shared/chat';
import { messagesSinceBoundary } from '@shared/chat';
import { isImportedMessageId } from '@shared/claudeImport';

/**
 * Carrying on a conversation imported from Claude with whatever model this app is set to.
 *
 * Imported tool calls are replayed as prose, not as tool_use/tool_result pairs: their names
 * (Agent, mcp__..., Skill) are not tools this app offers, and a provider shown a call to a tool
 * it was not given may reject the request. The model still learns what was run and what it said.
 */

/** Per call, enough of the result to know what it showed; the rest is in the thread. */
const RESULT_EXCERPT_CHARS = 1500;

/**
 * Past this much imported history (about 40K tokens) the first continued turn compacts first.
 * Imported messages carry no measured usage, so shouldAutoCompact cannot see their size.
 */
export const IMPORTED_COMPACT_CHARS = 160_000;

/** The taint source a continued imported session's replies start with; see ChatService DirectoryTurn. */
export const IMPORTED_TAINT_SOURCE = 'imported_conversation';

export function isImportedToolTurn(message: ChatMessage): boolean {
  return isImportedMessageId(message.id) && (message.toolCalls?.length ?? 0) > 0;
}

function argumentLine(input: Record<string, unknown>): string {
  for (const key of ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  }
  return '';
}

/** An imported assistant turn with tools, as the one text block the wire sends for it. */
export function importedTurnAsText(message: ChatMessage, text: string): string {
  const lines = text ? [text] : [];
  for (const call of message.toolCalls ?? []) {
    const argument = argumentLine(call.input);
    lines.push(`[Earlier tool call: ${call.name}${argument ? ` ${argument}` : ''}]`);
    const result = call.error ?? call.preview ?? '';
    if (result) {
      const excerpt =
        result.length > RESULT_EXCERPT_CHARS ? `${result.slice(0, RESULT_EXCERPT_CHARS)}\n[... truncated ...]` : result;
      lines.push(`[${call.error ? 'Error' : 'Result'}]\n${excerpt}`);
    }
  }
  return lines.join('\n\n');
}

function importedChars(message: ChatMessage): number {
  let total = message.content.length;
  for (const call of message.toolCalls ?? []) {
    total += Math.min((call.error ?? call.preview ?? '').length, RESULT_EXCERPT_CHARS) + 200;
  }
  return total;
}

/** True when the history about to be sent still holds more imported text than a first turn should carry. */
export function importedHistoryNeedsCompaction(session: ChatSession): boolean {
  if (!session.importOrigin) return false;
  let total = 0;
  for (const message of messagesSinceBoundary(session.messages)) {
    if (!isImportedMessageId(message.id)) continue;
    total += importedChars(message);
    if (total > IMPORTED_COMPACT_CHARS) return true;
  }
  return false;
}
