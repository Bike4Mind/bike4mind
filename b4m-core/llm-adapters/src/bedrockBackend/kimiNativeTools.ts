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

const SECTION_BEGIN = '<|tool_calls_section_begin|>';
const SECTION_END = '<|tool_calls_section_end|>';

/** Cheap gate: is there any native tool-call marker in this text at all? */
export function hasNativeToolMarker(text: string): boolean {
  return text.includes(SECTION_BEGIN) || text.includes('<|tool_call_begin|>');
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

/**
 * Parse the calls out of one section's inner text (between the section markers, or a
 * whole string that contains them - the per-call regex ignores the section markers).
 */
export function parseNativeToolSection(section: string): ParsedNativeToolCall[] {
  const calls: ParsedNativeToolCall[] = [];
  const re = /<\|tool_call_begin\|>\s*([\s\S]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
  let match: RegExpExecArray | null;
  let fallbackIndex = 0;
  while ((match = re.exec(section)) !== null) {
    const rawId = match[1].trim();
    const args = match[2].trim();
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

  push(chunk: string): { text: string; toolCalls: ParsedNativeToolCall[] } {
    this.buffer += chunk;
    let text = '';
    const toolCalls: ParsedNativeToolCall[] = [];

    for (;;) {
      if (!this.inSection) {
        const start = this.buffer.indexOf(SECTION_BEGIN);
        if (start >= 0) {
          text += this.buffer.slice(0, start);
          this.buffer = this.buffer.slice(start + SECTION_BEGIN.length);
          this.inSection = true;
          continue;
        }
        // No section start in view: surface everything except a tail that might be a
        // section-begin marker split across the next chunk.
        const hold = partialMarkerTail(this.buffer, SECTION_BEGIN);
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
   * Surface any held-back tail at end of stream. Non-empty only when a section-begin
   * prefix was held but never completed (i.e. it was ordinary text ending in `<|...`),
   * so it is safe to emit. A genuinely unterminated section is dropped rather than
   * leaked.
   */
  flush(): string {
    if (this.inSection) return '';
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }
}
