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
 * With `truncated` (a Stop or an error cut the reply off), a block left unclosed at the very end
 * that already names an offered tool is stripped too.
 *
 * A block must open at the start of a line, outside code fences and `<think>` spans, so prose,
 * inline code and fenced examples that mention these tags are left untouched.
 */

import { THINK_CLOSE_TAG, THINK_OPEN_TAG, visibleReplyText } from './streamVisibility';

export interface NarratedToolCallOptions {
  /** Tools offered on the turn. When set, only blocks naming one of them are stripped. */
  offeredToolNames?: readonly string[];
  /**
   * The reply was cut off, so nothing can follow its end: a trailing unclosed block naming an
   * offered tool is stripped as well. Only applies with `offeredToolNames`.
   */
  truncated?: boolean;
}

export interface StrippedNarratedToolCalls {
  text: string;
  /** Tool names the stripped blocks named, in order, each once. Empty when nothing was stripped. */
  toolNames: string[];
  /** True when nothing visible follows the last stripped call. Text before it may still be visible. */
  endsOnCall: boolean;
}

interface RunState {
  /** Open code fence marker, carried across runs: a fence can span a `<think>` span between them. */
  fence: string | null;
  /** Offset in the run's output where its last call was stripped, or null when none was. */
  strippedAt: number | null;
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
const MISTRAL_ARGS_NAME = /^\s*([\w.-]+)\[ARGS\]/;
// First complete `"name": "..."` in a cut-off JSON body; later ones may sit inside the arguments.
const CUT_OFF_JSON_NAME = /"name"\s*:\s*"([^"\\]+)"/;
const FENCE_MARKER = /`{3}|~{3}/;
// A blank line, then text that is not a tag: the answer after an invoke/function body.
const PROSE_AFTER_BLANK_LINE = /\n[ \t]*\r?\n[ \t]*[^<\s]/;
const INNER_CLOSE = /<\/(?:[\w-]+:)?(?:invoke|function)>/g;
const CALL_TAGS = /<\/?(?:[\w-]+:)?(?:function_calls|invoke|parameter|function|tool_call|tool_use)\b[^<>]*>/g;
const JSON_LITERAL = /(?:true|false|null)\b/y;
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

/**
 * The tool name a cut-off block body already names in full, or null when it names none yet. The
 * cut-off counterpart of calledToolNames: keep the two in sync when a block format is added.
 */
function cutOffToolNames(body: string, isMistral: boolean): string[] | null {
  const first = body.trimStart()[0];
  const named =
    first === '{' || first === '['
      ? body.match(CUT_OFF_JSON_NAME)
      : isMistral
        ? body.match(MISTRAL_ARGS_NAME)
        : body.match(FUNCTION_TAG);
  if (named) return [named[1]];
  if (first === '{' || first === '[' || isMistral) return null;
  const invoked = [...body.matchAll(INVOKE_NAME)].map(match => match[1]);
  return invoked.length > 0 ? invoked : null;
}

/** Whether an invoke/function body is still open: no answer follows its last inner close tag. */
function tagBodyStillOpen(body: string): boolean {
  let afterClose = -1;
  for (const match of body.matchAll(INNER_CLOSE)) afterClose = match.index + match[0].length;
  if (afterClose !== -1) {
    let rest = body.slice(afterClose);
    // A tag still being written at the very end is part of the call, not an answer.
    const lastOpen = rest.lastIndexOf('<');
    if (lastOpen !== -1 && !rest.includes('>', lastOpen)) rest = rest.slice(0, lastOpen);
    if (rest.replace(CALL_TAGS, '').trim()) return false;
  }
  return !PROSE_AFTER_BLANK_LINE.test(body);
}

/**
 * Whether a cut-off body is still open at its end, so no answer can follow it. A JSON body that
 * already closed, or that a blank line and prose interrupt, and an invoke/function body with text
 * after its last inner close tag, are calls missing their close tag with the answer after them.
 */
function stillOpen(body: string, isMistral: boolean): boolean {
  const args = isMistral ? body.match(MISTRAL_ARGS_NAME) : null;
  const json = args ? body.slice(args[0].length) : body;
  const start = json.search(/\S/);
  if (start === -1) return true;
  if (json[start] !== '{' && json[start] !== '[') return !isMistral && tagBodyStillOpen(body);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let newlines = 0;
  for (let i = start; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '\n') newlines += 1;
    if (/\s/.test(char)) continue;
    // Outside a string, JSON never starts a line with a bare word other than a literal.
    if (newlines >= 2 && /[A-Za-z]/.test(char)) {
      JSON_LITERAL.lastIndex = i;
      if (!JSON_LITERAL.test(json)) return false;
    }
    newlines = 0;
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if ((char === '}' || char === ']') && --depth === 0) return !json.slice(i + 1).trim();
  }
  return true;
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
 * unclosed one may be followed by the real answer, so it is cut only when `cutOff` says the run
 * is where the reply was cut off.
 */
function stripRun(
  run: string,
  offered: ReadonlySet<string> | null,
  toolNames: string[],
  state: RunState,
  cutOff: boolean
): string {
  const streaming = !offered;
  let out = '';
  let copiedTo = 0;
  let lineStart = 0;
  // Only the first unclosed opener can be the cut-off block: every later one sits inside it.
  let cutOffPending = cutOff && !!offered;
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

    const fence = state.fence;
    if (fence) {
      const close = line.match(FENCE_CLOSE_LINE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) state.fence = null;
      lineStart = nextLine;
      continue;
    }
    const fenceOpen = line.match(FENCE_OPEN_LINE);
    if (fenceOpen && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'))) {
      state.fence = fenceOpen[1];
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
    if (!hide && cutOffPending && offered && (!complete || isMistral)) {
      cutOffPending = false;
      const body = run.slice(bodyStart);
      if (
        body.length <= MAX_CALL_BODY_CHARS &&
        startsLikeCall(run, bodyStart, isMistral) &&
        stillOpen(body, isMistral)
      ) {
        names = cutOffToolNames(body, isMistral);
        hide = !!names && names.some(name => offered.has(name));
        if (!hide) names = null;
      }
    }
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
    if (names) state.strippedAt = out.length;
    for (const name of names ?? []) if (!toolNames.includes(name)) toolNames.push(name);
    lineStart = end;
  }
  return out + run.slice(copiedTo);
}

/**
 * One slot, with the fence state carried in from the slots before it. `truncated` marks the slot
 * as the one the reply was cut off in, so only its final visible run can end on a cut-off block.
 */
function stripSlot(
  text: string,
  offered: ReadonlySet<string> | null,
  toolNames: string[],
  state: RunState,
  truncated: boolean
): { text: string; endsOnCall: boolean } {
  // Fence markers still have to be walked: an open fence carries into the next slot.
  if (!text || (!text.includes('<') && !text.includes(MISTRAL_MARKER) && !FENCE_MARKER.test(text))) {
    return { text, endsOnCall: false };
  }

  // Same depth walk as visibleReplyText in ./streamVisibility.ts.
  let lastStrippedAt: number | null = null;
  let depth = 0;
  let out = '';
  const tokens = text.split(/(<think>|<\/think>)/);
  tokens.forEach((token, index) => {
    if (token === THINK_OPEN_TAG) depth += 1;
    else if (token === THINK_CLOSE_TAG) depth = Math.max(0, depth - 1);
    if (depth !== 0 || token === THINK_CLOSE_TAG) {
      out += token;
      return;
    }
    state.strippedAt = null;
    const stripped = stripRun(token, offered, toolNames, state, truncated && index === tokens.length - 1);
    if (state.strippedAt !== null) lastStrippedAt = out.length + state.strippedAt;
    out += stripped;
  });
  const endsOnCall = lastStrippedAt !== null && !visibleReplyText(out.slice(lastStrippedAt));
  return { text: out, endsOnCall };
}

/**
 * Removes narrated tool-call blocks from one reply slot. Text inside `<think>` spans is never
 * touched; the visible text around them is processed span by span.
 */
export function stripNarratedToolCalls(text: string, options: NarratedToolCallOptions = {}): StrippedNarratedToolCalls {
  const toolNames: string[] = [];
  const offered = options.offeredToolNames ? new Set(options.offeredToolNames) : null;
  const state: RunState = { fence: null, strippedAt: null };
  const result = stripSlot(text, offered, toolNames, state, !!options.truncated);
  return { ...result, toolNames };
}

/**
 * {@link stripNarratedToolCalls} over every reply slot, with the named tools collected once each.
 * Slots are read as one text, the way extractReplies in apps/client/shared/replyUtils.ts joins them
 * (joinReplySlots in ./streamVisibility.ts): a code fence opened in one slot still holds in the
 * next. Every slot starts on a new line there, so each slot's first line can open a block.
 */
export function stripNarratedToolCallsFromReplies(
  replies: readonly string[],
  options: NarratedToolCallOptions = {}
): { replies: string[]; toolNames: string[]; endsOnCall: boolean } {
  const toolNames: string[] = [];
  const offered = options.offeredToolNames ? new Set(options.offeredToolNames) : null;
  const state: RunState = { fence: null, strippedAt: null };
  let lastFilled = replies.length - 1;
  while (lastFilled > 0 && !replies[lastFilled].trim()) lastFilled -= 1;
  let endsOnCall = false;
  const stripped = replies.map((slot, index) => {
    const result = stripSlot(slot, offered, toolNames, state, !!options.truncated && index === lastFilled);
    if (result.endsOnCall) endsOnCall = true;
    else if (visibleReplyText(result.text)) endsOnCall = false;
    return result.text;
  });
  return { replies: stripped, toolNames, endsOnCall };
}

/**
 * Finalize step: strips narrated calls naming an offered tool from `replies` and `reply`. Mutates
 * `quest`. Returns the tool names the stripped calls named (empty when nothing was stripped) and
 * whether the reply ended on one, read from the slots when there are any.
 */
export function applyNarratedToolCallStrip(
  quest: { reply?: string | null; replies?: string[] },
  offeredToolNames: readonly string[],
  { truncated = false }: Pick<NarratedToolCallOptions, 'truncated'> = {}
): { toolNames: string[]; endsOnCall: boolean } {
  const options = { offeredToolNames, truncated };
  const fromSlots = stripNarratedToolCallsFromReplies(quest.replies ?? [], options);
  const fromReply = typeof quest.reply === 'string' ? stripNarratedToolCalls(quest.reply, options) : null;
  if (quest.replies) quest.replies = fromSlots.replies;
  if (fromReply) quest.reply = fromReply.text;
  const toolNames = [...fromSlots.toolNames];
  for (const name of fromReply?.toolNames ?? []) if (!toolNames.includes(name)) toolNames.push(name);
  const endsOnCall = quest.replies?.length ? fromSlots.endsOnCall : (fromReply?.endsOnCall ?? false);
  return { toolNames, endsOnCall };
}
