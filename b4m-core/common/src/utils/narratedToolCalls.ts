/**
 * Narrated tool calls: a tool call the model wrote into its reply as text instead of using the
 * provider's tool-call channel (`<tool_call>{...}</tool_call>`, `<tool_use>`, `<function_calls>`
 * with `<invoke>`, Mistral's `[TOOL_CALLS]`). Nothing runs such a call, so the raw syntax would
 * otherwise render as the answer and be replayed to the model on the next turn.
 *
 * These are hidden, never executed: parsing text into a real call would skip schema validation,
 * and quoted or injected text could trigger tools. The one provider format that IS converted into
 * real calls is Kimi's native token section, in llm-adapters bedrockBackend/kimiNativeTools.ts.
 *
 * Two callers, two strictness levels:
 * - finalize (ChatCompletionProcess) passes `offeredToolNames`, and only a complete block naming a
 *   tool offered on that turn is stripped from the stored reply;
 * - rendering (extractReplies in apps/client/shared/replyUtils.ts) passes none, and also hides a
 *   block that is still streaming, the way a streaming choices fence is hidden.
 *
 * A block must open at the start of a line, outside code fences and `<think>` spans, so prose,
 * inline code and fenced examples that mention these tags are left untouched.
 */

import { THINK_CLOSE_TAG, THINK_OPEN_TAG } from './streamVisibility';

export interface NarratedToolCallOptions {
  /** Tools offered on the turn. When set, only blocks naming one of them are stripped. */
  offeredToolNames?: readonly string[];
}

export interface StrippedNarratedToolCalls {
  text: string;
  /** Tool names the stripped blocks named, in order, each once. Empty when nothing was stripped. */
  toolNames: string[];
}

/** Shown in place of a stripped block; the call it describes was never run. */
export const NARRATED_TOOL_CALL_NOTICE =
  'The model wrote a tool call as text instead of running it, so the tool did not run. Please try again.';

const MISTRAL_MARKER = '[TOOL_CALLS]';
const OPENER = /^[ \t]*(?:<((?:[\w-]+:)?(?:tool_call|tool_use|function_calls))>|\[TOOL_CALLS\])/;
/** Bare openers, for holding back a partial one while it streams. */
const OPENER_LITERALS = ['<tool_call>', '<tool_use>', '<function_calls>', MISTRAL_MARKER];
const INVOKE_NAME = /<(?:[\w-]+:)?invoke\s+name=["']([^"']+)["']/g;
const FUNCTION_TAG = /^\s*<function=([\w.-]+)>/;
const MISTRAL_ARGS_CALL = /([\w.-]+)\[ARGS\]/g;
// Same fence rules as findLastChoicesFence in ./replyChoices.ts.
const FENCE_OPEN_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function jsonToolName(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const { name, function: fn } = item as { name?: unknown; function?: { name?: unknown } };
  if (typeof name === 'string' && name) return name;
  return fn && typeof fn.name === 'string' && fn.name ? fn.name : null;
}

function jsonToolNames(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  const names = (Array.isArray(parsed) ? parsed : [parsed]).map(jsonToolName);
  return names.length > 0 && names.every(name => name !== null) ? (names as string[]) : null;
}

/** The tool names a block body calls, or null when the body is not a tool call. */
function calledToolNames(body: string, isMistral: boolean): string[] | null {
  const fromJson = jsonToolNames(body);
  if (fromJson) return fromJson;
  if (isMistral) {
    if (!/^[\w.-]+\[ARGS\]/.test(body)) return null;
    return [...body.matchAll(MISTRAL_ARGS_CALL)].map(match => match[1]);
  }
  const invoked = [...body.matchAll(INVOKE_NAME)].map(match => match[1]);
  if (invoked.length > 0) return invoked;
  const fnTag = body.match(FUNCTION_TAG);
  return fnTag ? [fnTag[1]] : null;
}

/** Whether an unterminated block body could still become a call once more text streams in. */
function couldBeStreamingCall(body: string, isMistral: boolean): boolean {
  const trimmed = body.trimStart();
  if (trimmed === '' || /^[{[<]/.test(trimmed)) return true;
  return isMistral && /^[\w.-]+(?:\[|$)/.test(body);
}

function stripRun(run: string, offered: ReadonlySet<string> | null, toolNames: string[]): string {
  let out = '';
  let copiedTo = 0;
  let fence: string | null = null;
  let lineStart = 0;
  while (lineStart < run.length) {
    const newline = run.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? run.length : newline;
    const line = run.slice(lineStart, lineEnd).replace(/\r$/, '');
    const nextLine = newline === -1 ? run.length : newline + 1;

    if (fence) {
      const close = line.match(FENCE_CLOSE_LINE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      lineStart = nextLine;
      continue;
    }
    const fenceOpen = line.match(FENCE_OPEN_LINE);
    if (fenceOpen && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'))) {
      fence = fenceOpen[1];
      lineStart = nextLine;
      continue;
    }

    const opener = line.match(OPENER);
    if (!opener) {
      const partial = line.trim();
      const isLastLine = newline === -1;
      if (
        !offered &&
        isLastLine &&
        partial.length >= 2 &&
        OPENER_LITERALS.some(literal => literal !== partial && literal.startsWith(partial))
      ) {
        out += run.slice(copiedTo, lineStart);
        copiedTo = run.length;
      }
      lineStart = nextLine;
      continue;
    }

    const tag = opener[1];
    const isMistral = !tag;
    const bodyStart = lineStart + opener[0].length;
    const closeTag = tag ? `</${tag}>` : null;
    const closeAt = closeTag ? run.indexOf(closeTag, bodyStart) : -1;
    const body = closeAt === -1 ? run.slice(bodyStart) : run.slice(bodyStart, closeAt);
    const names = calledToolNames(body, isMistral);
    const hide = names
      ? !offered || names.some(name => offered.has(name))
      : !offered && closeAt === -1 && couldBeStreamingCall(body, isMistral);
    if (!hide) {
      lineStart = nextLine;
      continue;
    }

    let end = closeAt === -1 || !closeTag ? run.length : closeAt + closeTag.length;
    // Take the rest of the closing line too when it is blank, so no empty line is left behind.
    const trailing = run.slice(end).match(/^[ \t]*(?:\r?\n|$)/);
    if (trailing) end += trailing[0].length;
    out += run.slice(copiedTo, lineStart);
    copiedTo = end;
    for (const name of names ?? []) if (!toolNames.includes(name)) toolNames.push(name);
    lineStart = end;
  }
  return out + run.slice(copiedTo);
}

/**
 * Removes narrated tool-call blocks from one reply slot. Text inside `<think>` spans is never
 * touched; the visible text around them is processed span by span.
 */
export function stripNarratedToolCalls(text: string, options: NarratedToolCallOptions = {}): StrippedNarratedToolCalls {
  const toolNames: string[] = [];
  if (!text || (!text.includes('<') && !text.includes(MISTRAL_MARKER))) return { text, toolNames };
  const offered = options.offeredToolNames ? new Set(options.offeredToolNames) : null;

  // Same depth walk as visibleReplyText in ./streamVisibility.ts.
  let depth = 0;
  let out = '';
  for (const token of text.split(/(<think>|<\/think>)/)) {
    if (token === THINK_OPEN_TAG) depth += 1;
    else if (token === THINK_CLOSE_TAG) depth = Math.max(0, depth - 1);
    out += depth === 0 && token !== THINK_CLOSE_TAG ? stripRun(token, offered, toolNames) : token;
  }
  return { text: out, toolNames };
}

/** {@link stripNarratedToolCalls} over every reply slot, with the named tools collected once each. */
export function stripNarratedToolCallsFromReplies(
  replies: readonly string[],
  options: NarratedToolCallOptions = {}
): { replies: string[]; toolNames: string[] } {
  const toolNames: string[] = [];
  const stripped = replies.map(slot => {
    const result = stripNarratedToolCalls(slot, options);
    for (const name of result.toolNames) if (!toolNames.includes(name)) toolNames.push(name);
    return result.text;
  });
  return { replies: stripped, toolNames };
}

/**
 * Finalize step: strips narrated calls naming an offered tool from `replies` and `reply`. Mutates
 * `quest`. Returns the tool names the stripped calls named; empty when nothing was stripped.
 */
export function applyNarratedToolCallStrip(
  quest: { reply?: string | null; replies?: string[] },
  offeredToolNames: readonly string[]
): string[] {
  const fromSlots = stripNarratedToolCallsFromReplies(quest.replies ?? [], { offeredToolNames });
  const fromReply = typeof quest.reply === 'string' ? stripNarratedToolCalls(quest.reply, { offeredToolNames }) : null;
  if (quest.replies) quest.replies = fromSlots.replies;
  if (fromReply) quest.reply = fromReply.text;
  const toolNames = [...fromSlots.toolNames];
  for (const name of fromReply?.toolNames ?? []) if (!toolNames.includes(name)) toolNames.push(name);
  return toolNames;
}
