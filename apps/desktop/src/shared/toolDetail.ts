import { snippetOf } from './agentOutcome';
import type { ChatToolCall } from './chat';

const DETAIL_MAX = 60;
const DETAIL_KEYS = ['path', 'file_path', 'command', 'pattern', 'query', 'url'] as const;
const PATH_KEYS: ReadonlySet<string> = new Set(['path', 'file_path']);

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The one argument that says what a tool call is for: a file name, a command, a query. Empty if none. */
export function describeToolInput(call: Pick<ChatToolCall, 'name' | 'input'>): string {
  for (const key of DETAIL_KEYS) {
    const value = call.input[key];
    if (typeof value !== 'string' || value === '') continue;
    return snippetOf(PATH_KEYS.has(key) ? basename(value) : value, DETAIL_MAX);
  }
  return '';
}
