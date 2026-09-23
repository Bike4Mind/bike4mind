/**
 * Which part of a streamed assistant reply the user actually sees.
 *
 * Reasoning-capable backends do not signal hidden thinking out-of-band; they wrap it in these
 * markers inside the streamed text itself. Every one that supports reasoning emits the pair -
 * anthropicBackend, bedrockBackend/anthropic, kimiBackend, deepseekBackend, xaiBackend and
 * ollamaBackend all open it as the thinking block starts - so the markers are the only cross-provider signal for
 * visibility, and the chat UI strips exactly this pair when rendering.
 *
 * Grep the tag constants below rather than trusting a line number: these emit sites move.
 */
export const THINK_OPEN_TAG = '<think>';
export const THINK_CLOSE_TAG = '</think>';

/** Splits on the marker tokens, keeping them in the result so a scan can track nesting depth. */
const THINK_TAG_TOKENS = /(<think>|<\/think>)/g;

/**
 * Zero-width space spliced into a defanged marker. It is invisible wherever the text is
 * rendered, so escaping never changes what the reader sees - only what the parser matches.
 */
const ZERO_WIDTH_SPACE = '​';

/**
 * Defangs think-marker-shaped substrings inside provider-authored reasoning text so they can
 * never be mistaken for the real control markers adapters wrap around that same text.
 *
 * A reasoning delta is provider output, not our control plane - a model can say `<think>` or
 * `</think>` as literal content (reasoning about the protocol itself, or a leading/trailing
 * `</think>` from a provider that already delimits its own monologue). Adapters wrap the whole
 * delta in real markers via plain string concatenation, so an unescaped literal is
 * indistinguishable from a genuine open/close once it lands in the same string. Call this on
 * every raw reasoning delta before it is concatenated with THINK_OPEN_TAG/THINK_CLOSE_TAG.
 */
export function escapeThinkMarkers(text: string): string {
  if (!text) return text;
  return text.replace(/<(\/?)think>/g, `<${ZERO_WIDTH_SPACE}$1think>`);
}

/** One less than the longer marker's length: the most characters a real marker prefix can span. */
const MAX_PARTIAL_MARKER_LENGTH = THINK_CLOSE_TAG.length - 1;

/** Length of the longest suffix of `text` that is a proper prefix of either marker token. */
function partialMarkerSuffixLength(text: string): number {
  const max = Math.min(MAX_PARTIAL_MARKER_LENGTH, text.length);
  for (let len = max; len > 0; len--) {
    const suffix = text.slice(-len);
    if (THINK_OPEN_TAG.startsWith(suffix) || THINK_CLOSE_TAG.startsWith(suffix)) {
      return len;
    }
  }
  return 0;
}

export interface ThinkMarkerEscaper {
  /** Escapes as much of `chunk` as is safe to emit now; holds back a possible marker prefix. */
  push(chunk: string): string;
  /** Escapes and returns whatever is still held back. Call once the reasoning span ends. */
  flush(): string;
}

/**
 * Stateful counterpart to escapeThinkMarkers for text that arrives in streamed pieces.
 *
 * escapeThinkMarkers alone is only safe on a complete string: adapters call it once per
 * delta, but a provider is free to split a marker-shaped substring across two adjacent
 * deltas (e.g. 'wrote <th' then 'ink> tag'). Escaping each half independently leaves both
 * halves unescaped, and concatenating them reassembles a literal `<think>`/`</think>` that
 * is then indistinguishable from the real control marker wrapped around the same text.
 *
 * This holds back any trailing substring of the buffered text that could still extend into
 * a marker (up to `<think>`/`</think>`'s length minus one) until the next push resolves it
 * one way or the other, or flush() is called at the end of the reasoning span.
 */
export function createThinkMarkerEscaper(): ThinkMarkerEscaper {
  let pending = '';
  return {
    push(chunk: string): string {
      if (!chunk) return '';
      const combined = pending + chunk;
      const holdLength = partialMarkerSuffixLength(combined);
      const safeLength = combined.length - holdLength;
      const safe = combined.slice(0, safeLength);
      pending = combined.slice(safeLength);
      return escapeThinkMarkers(safe);
    },
    flush(): string {
      const remaining = pending;
      pending = '';
      return escapeThinkMarkers(remaining);
    },
  };
}

/**
 * The visible remainder of one reply slot, with hidden reasoning removed.
 *
 * This is the rule the chat transcript renders by - `extractReplies` in
 * apps/client/app/utils/replyUtils.ts calls straight into it, so the two cannot drift.
 * Anything deriving "did the user see something yet" (latency metrics in particular) must
 * use this and not a looser non-empty check: a metric built on a looser rule reports text
 * as seen while the UI is still hiding it.
 *
 * Thinking is removed span by span rather than by keeping the tail after the last close
 * marker. A turn that answers, calls a tool and then thinks again reopens its thinking
 * inside the slot that already holds the partial answer (the provider restarts its
 * content-block indices - see appendStreamedChunk), so a tail rule would drop text the user
 * has already watched stream in. An unclosed trailing marker hides everything after it, so a
 * reopened block does not render its raw marker while it streams.
 *
 * Markers are tracked by nesting depth rather than matched pairwise, because reasoning text
 * is provider-authored and can itself contain marker-shaped substrings (a model reasoning
 * about the `<think>` protocol, say). A naive non-greedy pair match on
 * `<think>outer<think>inner</think>tail</think>answer` would strip only the innermost pair
 * and let `tail` leak into the transcript; walking depth instead keeps everything between an
 * open and its matching close hidden regardless of what markers appear in between, and an
 * unmatched trailing `</think>` (depth already zero) is treated as ordinary text rather than
 * closing something that was never open.
 *
 * Interior whitespace is preserved: callers concatenate slots with no separator, so trimming
 * every slot would weld a heading onto the table beneath it.
 */
export function visibleReplyText(part: string | null | undefined): string {
  if (!part || !part.trim()) return '';

  let depth = 0;
  let visible = '';
  for (const token of part.split(THINK_TAG_TOKENS)) {
    if (token === THINK_OPEN_TAG) {
      depth += 1;
    } else if (token === THINK_CLOSE_TAG) {
      if (depth > 0) depth -= 1;
      else visible += token;
    } else if (depth === 0) {
      visible += token;
    }
  }

  return visible.trim() ? visible : '';
}

/** Whether any slot of an in-progress reply carries text the user can see. */
export function hasVisibleReplyText(parts: readonly (string | null | undefined)[]): boolean {
  return parts.some(part => visibleReplyText(part).trim().length > 0);
}

/**
 * Adapter families whose reasoning can NEVER reach the text channel, so a surface that must
 * hide reasoning can serve them.
 *
 * An allowlist, not a denylist, because this is a redaction gate: the families that do
 * inline reasoning (kimiBackend.ts:526, deepseekBackend.ts:472, xaiBackend.ts:602,
 * ollamaBackend.ts:492, bedrockBackend/deepseek.ts:309, bedrockBackend/moonshot.ts:57) wrap
 * it in the markers above with nothing else separating it, and the text between them is
 * model-generated - so reasoning containing the close marker ends a parsed redaction early.
 * A family nobody has vetted must not inherit permission by being new.
 *
 * The anthropic families qualify because their reasoning is opt-in per request, arrives at
 * its own content-block index, and has each marker emitted as a whole chunk by the adapter
 * (anthropicBackend.ts:1338,1423; bedrockBackend/anthropic.ts:1155) rather than as model
 * text. openai/gemini emit no markers at all.
 *
 * Keyed on adapterFamily, not model id, so a newly discovered model on a vetted provider
 * works the day it appears in the catalog while a new PROVIDER stays refused until vetted.
 */
export const REASONING_SAFE_ADAPTER_FAMILIES: readonly string[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'bedrock-anthropic',
  'gemini',
];

/**
 * Whether this adapter family can put model-generated reasoning in the text channel.
 * Anything not explicitly vetted reads as true, so callers fail closed.
 */
export function inlinesReasoningIntoText(adapterFamily: string | null | undefined): boolean {
  if (!adapterFamily) return true;
  return !REASONING_SAFE_ADAPTER_FAMILIES.includes(adapterFamily);
}
