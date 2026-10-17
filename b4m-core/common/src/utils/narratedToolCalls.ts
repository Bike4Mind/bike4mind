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
 * Two strictness levels:
 * - with `offeredToolNames`, only a complete block naming one of those tools is stripped. Finalize
 *   (ChatCompletionProcess) passes the turn's tools; extractReplies in
 *   apps/client/shared/replyUtils.ts passes the names finalize recorded, so a finished reply
 *   renders exactly what was stored;
 * - without it (a reply still streaming), any well-formed block is hidden, and so is a block or
 *   opener still being written at the end, the way a streaming choices fence is hidden.
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
// At most 3 leading spaces: 4 makes the line an indented code block in markdown.
const OPENER = /^ {0,3}(?:<((?:[\w-]+:)?(?:tool_call|tool_use|function_calls))>|\[TOOL_CALLS\])/;
/** Bare openers, for holding back a partial one while it streams. */
const OPENER_LITERALS = ['<tool_call>', '<tool_use>', '<function_calls>', MISTRAL_MARKER];
/** First non-blank characters a call body can start with: JSON, `<invoke`, `<function=`, or a Mistral name. */
const CALL_BODY_START = /\s*(?:[{[]|<(?:[\w-]+:)?invoke\s|<function=|[\w.-]+\[ARGS\])/y;
const INVOKE_NAME = /<(?:[\w-]+:)?invoke\s+name=["']([^"']+)["']/g;
const FUNCTION_TAG = /^\s*<function=([\w.-]+)>/;
const MISTRAL_ARGS_SPLIT = /([\w.-]+)\[ARGS\]/;
const BLANK_LINE_REST = /[ \t]*(?:\r?\n|$)/y;
// Same fence rules as findLastChoicesFence in ./replyChoices.ts.
const FENCE_OPEN_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
/**
 * Longest block body that is parsed. Bounds the work per opener so a reply full of openers stays
 * linear; a longer narrated call is left visible rather than parsed.
 */
const MAX_CALL_BODY_CHARS = 16_000;

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

/** `name[ARGS]{json}` repeated, and nothing else: each argument chunk must parse. */
function mistralArgsToolNames(body: string): string[] | null {
  const parts = body.split(MISTRAL_ARGS_SPLIT);
  if (parts.length < 3 || parts[0].trim()) return null;
  const names: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    try {
      JSON.parse(parts[i + 1]);
    } catch {
      return null;
    }
    names.push(parts[i]);
  }
  return names;
}

/** The tool names a complete block body calls, or null when the body is not a tool call. */
function calledToolNames(body: string, isMistral: boolean): string[] | null {
  const first = body.trimStart()[0];
  if (first === '{' || first === '[') return jsonToolNames(body);
  if (isMistral) return mistralArgsToolNames(body);
  if (FUNCTION_TAG.test(body)) return [body.match(FUNCTION_TAG)![1]];
  const invoked = [...body.matchAll(INVOKE_NAME)].map(match => match[1]);
  return invoked.length > 0 ? invoked : null;
}

/** Whether the body at `bodyStart` is empty so far or starts the way a call body does. */
function startsLikeCall(run: string, bodyStart: number, isMistral: boolean): boolean {
  const head = run.slice(bodyStart, bodyStart + 64);
  if (!head.trim()) return true;
  CALL_BODY_START.lastIndex = bodyStart;
  if (CALL_BODY_START.test(run)) return true;
  if (bodyStart + head.length !== run.length) return false;
  // Still streaming in: an `<invoke`/`<function=` prefix, or a Mistral name before its `[ARGS]`.
  const partial = head.trimStart();
  if (['<invoke ', '<function='].some(start => start.startsWith(partial))) return true;
  return isMistral && /^[\w.-]+$/.test(head);
}

/**
 * `streaming` (no offered list) hides any well-formed block, plus a block or opener still being
 * written at the end. Otherwise only a complete block naming an offered tool is stripped: an
 * unclosed one may be followed by the real answer, so it is never cut.
 */
function stripRun(run: string, offered: ReadonlySet<string> | null, toolNames: string[]): string {
  const streaming = !offered;
  let out = '';
  let copiedTo = 0;
  let fence: string | null = null;
  let lineStart = 0;
  // Next known offset of each close tag, or -1 once it is absent from the rest of the run. Offsets
  // only move forward, so each tag costs one pass over the run in total.
  const nextClose = new Map<string, number>();
  const findClose = (closeTag: string, from: number): number => {
    const known = nextClose.get(closeTag);
    if (known === -1 || (known !== undefined && known >= from)) return known;
    const found = run.indexOf(closeTag, from);
    nextClose.set(closeTag, found);
    return found;
  };

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
      if (
        streaming &&
        newline === -1 &&
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
    // A Mistral call has no close marker; it runs to the end of the text.
    const bodyEnd = closeTag ? findClose(closeTag, bodyStart) : run.length;
    const complete = !closeTag || bodyEnd !== -1;

    let names: string[] | null = null;
    let hide = false;
    if (complete && bodyEnd - bodyStart <= MAX_CALL_BODY_CHARS && startsLikeCall(run, bodyStart, isMistral)) {
      names = calledToolNames(run.slice(bodyStart, bodyEnd), isMistral);
      hide = !!names && (offered === null || names.some(name => offered.has(name)));
    }
    if (!hide && streaming && (!complete || isMistral)) hide = startsLikeCall(run, bodyStart, isMistral);
    if (!hide) {
      lineStart = nextLine;
      continue;
    }

    let end = closeTag && complete ? bodyEnd + closeTag.length : run.length;
    // Take the rest of the closing line too when it is blank, so no empty line is left behind.
    BLANK_LINE_REST.lastIndex = end;
    const trailing = BLANK_LINE_REST.exec(run);
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
