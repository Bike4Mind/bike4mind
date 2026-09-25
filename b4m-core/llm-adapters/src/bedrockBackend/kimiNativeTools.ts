/**
 * Kimi (Moonshot) on Bedrock non-deterministically returns tool calls two ways:
 * as structured `tool_calls` deltas (handled directly in the backend), OR as its
 * NATIVE special-token format emitted inline in the content/reasoning stream:
 *
 *   <|tool_calls_section_begin|>
 *     <|tool_call_begin|> functions.<name>:<index> <|tool_call_argument_begin|> {json} <|tool_call_end|>
 *     ...more calls...
 *   <|tool_calls_section_end|>
 *
 * Nothing downstream parses that, so the tokens would leak into the answer as text
 * and the tool would never run. This module extracts the native section and yields
 * structured tool calls, so both provider shapes converge on the same execution path.
 *
 * Verified against live Bedrock captures (moonshot.kimi-k2-thinking, us-east-2):
 * the section is emitted WITHIN the model's reasoning, its markers span content
 * deltas, and a section can carry several parallel calls.
 */

export type ParsedNativeToolCall = { id: string; name: string; index: number; arguments: string };

export const SECTION_BEGIN = '<|tool_calls_section_begin|>';
export const SECTION_END = '<|tool_calls_section_end|>';
/**
 * Per-call markers. The section wrapper is not always present - a call can arrive bare -
 * so anything that scopes input to the calls has to fall back to these.
 */
export const CALL_BEGIN = '<|tool_call_begin|>';
const CALL_END = '<|tool_call_end|>';
const ARG_BEGIN = '<|tool_call_argument_begin|>';

/** Cheap gate: is there any native tool-call marker in this text at all? */
export function hasNativeToolMarker(text: string): boolean {
  return text.includes(SECTION_BEGIN) || text.includes(CALL_BEGIN);
}

/**
 * Offset of the first tool call in `text`, preferring the section wrapper when present,
 * or -1 when there is none.
 *
 * This is how a caller meets parseNativeToolSection's section-scoping contract. It is a
 * function rather than an inline indexOf because the wrapper is optional: scoping only on
 * SECTION_BEGIN leaves the bare shape falling through to the whole message.
 */
export function nativeToolCallsBegin(text: string): number {
  const section = text.indexOf(SECTION_BEGIN);
  return section >= 0 ? section : text.indexOf(CALL_BEGIN);
}

/** `functions.math_evaluate:0` -> { name: 'math_evaluate', index: 0 }. */
function splitNativeToolId(rawId: string, fallbackIndex: number): { name: string; index: number } {
  const withoutPrefix = rawId.startsWith('functions.') ? rawId.slice('functions.'.length) : rawId;
  const colon = withoutPrefix.lastIndexOf(':');
  if (colon >= 0) {
    const parsed = Number.parseInt(withoutPrefix.slice(colon + 1), 10);
    return { name: withoutPrefix.slice(0, colon), index: Number.isNaN(parsed) ? fallbackIndex : parsed };
  }
  return { name: withoutPrefix, index: fallbackIndex };
}

const LEADING_WHITESPACE = /\s*/y;

/**
 * Each call as [rawId, args], both trimmed. Yields the same calls as the former
 * /CB\s*([\s\S]+?)\s*AB\s*([\s\S]*?)\s*CE/g (JS trim() strips exactly the \s set),
 * but linearly: that regex was quadratic on a section of unterminated markers. Like the
 * regex, an id may swallow later markers when the first call is malformed.
 */
function scanNativeToolCalls(section: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let from = 0;
  for (;;) {
    const p = section.indexOf(CALL_BEGIN, from);
    if (p === -1) break;
    const e = p + CALL_BEGIN.length;
    LEADING_WHITESPACE.lastIndex = e;
    LEADING_WHITESPACE.exec(section);
    const s = LEADING_WHITESPACE.lastIndex;
    // The regex's first choice: all leading whitespace consumed, then a non-empty id. Its
    // only other match gives whitespace back so the id is blank, which yields no call,
    // and then no ARG_BEGIN past `s` has a CALL_END after it, so no later call matches.
    const argsAt = section.indexOf(ARG_BEGIN, s + 1);
    if (argsAt === -1) break;
    const end = section.indexOf(CALL_END, argsAt + ARG_BEGIN.length);
    if (end === -1) break;
    out.push([section.slice(e, argsAt).trim(), section.slice(argsAt + ARG_BEGIN.length, end).trim()]);
    from = end + CALL_END.length;
  }
  return out;
}

/**
 * Parse the calls out of ONE section's text.
 *
 * Callers pass text already scoped to the section - `inner.slice(sectionBegin)` at
 * minimum, not a whole message - so prose ahead of the section cannot be read as a
 * call. Both callers in this repo (the stream below, and the non-streaming branch in
 * moonshot.ts) slice first.
 */
export function parseNativeToolSection(section: string): ParsedNativeToolCall[] {
  const calls: ParsedNativeToolCall[] = [];
  let fallbackIndex = 0;
  for (const [rawId, args] of scanNativeToolCalls(section)) {
    const { name, index } = splitNativeToolId(rawId, fallbackIndex);
    if (name) calls.push({ id: rawId, name, index, arguments: args });
    fallbackIndex++;
  }
  return calls;
}

/** Length of the longest suffix of `buf` that is a proper prefix of `marker`. */
function partialMarkerTail(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (marker.startsWith(buf.slice(buf.length - n))) return n;
  }
  return 0;
}

/**
 * Stateful streaming filter. Feed reasoning/content text chunk by chunk; get back
 * the text that is safe to surface (everything outside a tool-call section) plus any
 * tool calls whose section completed in this push. Text that begins a section, or
 * that could be a partial section-begin marker split across chunks, is held back so
 * a raw `<|tool_call...|>` token never reaches the user. One instance per request.
 */
export class KimiNativeToolStream {
  private buffer = '';
  private inSection = false;
  /** Inside a bare call (no section wrapper), which ends at CALL_END rather than SECTION_END. */
  private inBareCall = false;

  push(chunk: string): { text: string; toolCalls: ParsedNativeToolCall[] } {
    this.buffer += chunk;
    let text = '';
    const toolCalls: ParsedNativeToolCall[] = [];

    for (;;) {
      if (this.inBareCall) {
        const end = this.buffer.indexOf(CALL_END);
        if (end === -1) break; // call still open: keep buffering, surface nothing
        const through = end + CALL_END.length;
        toolCalls.push(...parseNativeToolSection(this.buffer.slice(0, through)));
        this.buffer = this.buffer.slice(through);
        this.inBareCall = false;
        continue;
      }

      if (!this.inSection) {
        const start = this.buffer.indexOf(SECTION_BEGIN);
        const bare = this.buffer.indexOf(CALL_BEGIN);
        if (start >= 0 && (bare === -1 || start <= bare)) {
          text += this.buffer.slice(0, start);
          this.buffer = this.buffer.slice(start + SECTION_BEGIN.length);
          this.inSection = true;
          continue;
        }
        // A call can arrive with no section wrapper. Holding back only SECTION_BEGIN
        // surfaced those raw `<|tool_call_begin|>` tokens to the user as text, which is
        // the leak this class exists to prevent.
        if (bare >= 0) {
          text += this.buffer.slice(0, bare);
          this.buffer = this.buffer.slice(bare);
          this.inBareCall = true;
          continue;
        }
        // Neither marker in view: surface everything except a tail that might be either
        // marker split across the next chunk.
        const hold = Math.max(
          partialMarkerTail(this.buffer, SECTION_BEGIN),
          partialMarkerTail(this.buffer, CALL_BEGIN)
        );
        text += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = hold > 0 ? this.buffer.slice(this.buffer.length - hold) : '';
        break;
      }

      const end = this.buffer.indexOf(SECTION_END);
      if (end >= 0) {
        toolCalls.push(...parseNativeToolSection(this.buffer.slice(0, end)));
        this.buffer = this.buffer.slice(end + SECTION_END.length);
        this.inSection = false;
        continue;
      }
      // Section still open: keep buffering, surface nothing.
      break;
    }

    return { text, toolCalls };
  }

  /**
   * Surface any held-back tail at end of stream. Non-empty only when a begin-marker
   * prefix was held but never completed (i.e. it was ordinary text ending in `<|...`),
   * so it is safe to emit. A genuinely unterminated section or call is dropped rather
   * than leaked.
   */
  flush(): string {
    if (this.inSection || this.inBareCall) return '';
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }
}
