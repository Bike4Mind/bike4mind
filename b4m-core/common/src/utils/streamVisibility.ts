import type { AdapterFamily } from '../types/entities/ModelCatalogTypes';

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
 * Whether an adapter family can put model-generated reasoning into the TEXT channel - the
 * string handed to the completion callback, as opposed to a separate field.
 *
 * - `never`   - reasoning is not returned at all, or the adapter never asks for it.
 * - `opt-in`  - only when the caller enables it on the request; off by default.
 * - `always`  - whenever the model reasons, inlined at the SAME index as the prose and
 *               bracketed by the markers above, with nothing else separating the two.
 */
export type ReasoningChannel = 'never' | 'opt-in' | 'always';

/**
 * What a completion chunk carries when it is NOT the assistant's prose reply. Absent means
 * prose, which is the only thing a public/anonymous stream may forward.
 *
 * Set by the adapter at the emit site, where the distinction is still known; downstream the
 * frames are indistinguishable strings. Purely additive - adapters emit exactly what they
 * always did, and first-party surfaces that want reasoning or artifact frames keep getting
 * them. Only {@link buildPublicSSEEvent} acts on it.
 */
export type StreamChannel =
  /** A thinking/reasoning block, including the marker chunks that bracket it. */
  | 'reasoning'
  /** A raw tool result streamed for a renderer to pick up (see toolStreamingHelper). */
  | 'tool-artifact';

/**
 * Truth table over every declared AdapterFamily, each entry read off the adapter.
 *
 * Exhaustive by type: `Record<AdapterFamily, ...>` makes adding a family to the union a
 * compile error here, so a new provider cannot be admitted or refused by omission.
 *
 * `always` is the class a public surface cannot serve. Those adapters put reasoning and
 * reply prose in the SAME string at the SAME index - a delta can close the block and carry
 * the first words of the answer - so the per-frame channel tag, which is what keeps
 * `opt-in` families safe, has nothing to separate. Only parsing the markers could, and a
 * public surface does not parse: escapeThinkMarkers defangs marker-shaped text inside
 * REASONING, but a model is free to write `<think>` in its ANSWER, and a parser would
 * truncate that legitimate reply. So these families are refused before the stream opens.
 */
export const REASONING_CHANNEL_BY_ADAPTER_FAMILY: Record<AdapterFamily, ReasoningChannel> = {
  // Reasoning lands at the thinking block's OWN content-block index, each marker emitted as
  // a whole adapter chunk. `opt-in` describes the REQUEST only: anthropicBackend sets
  // apiParams.thinking just for a caller that asked. The RESPONSE is not bound by that - an
  // adaptive model reasons on every turn either way - so the stream loop TAGS those frames
  // (CompletionInfo.channel) and a public surface drops them on the tag, not on the marker.
  'anthropic-messages': 'opt-in',
  // Same shape through Bedrock, tagged on the choice.
  'bedrock-anthropic': 'opt-in',
  // Takes delta.content only; reasoning_effort is a REQUEST parameter and Chat Completions
  // returns no reasoning text.
  'openai-chat': 'never',
  // Forwards response.output_text.delta only, and the request carries reasoning.effort
  // without reasoning.summary, so no summary events exist to forward.
  'openai-responses': 'never',
  // Takes part.text only, and the adapter never sends includeThoughts/thinkingConfig, so
  // Gemini returns no thought parts to take.
  gemini: 'never',
  // Plain completions: chunkText comes from the provider's `generation` field.
  'bedrock-llama': 'never',
  'bedrock-jurassic': 'never',
  'bedrock-titan': 'never',
  // Each wraps the provider's separate reasoning field (reasoning_content, or Ollama's
  // `thinking`) in the markers at the SAME index as the prose - no other separator.
  xai: 'always',
  kimi: 'always',
  deepseek: 'always',
  ollama: 'always',
  'bedrock-deepseek': 'always',
  'bedrock-moonshot': 'always',
  // Not text completion at all - image, embedding and credential-only families. They cannot
  // back a chat agent, so they are refused rather than described.
  bfl: 'always',
  'local-image': 'always',
  aws: 'always',
  voyageai: 'always',
};

/**
 * Whether model-generated reasoning can reach the text channel on this family no matter
 * what the caller requests. Unknown/absent families read as true, so callers fail closed.
 *
 * `opt-in` families read as FALSE, so a caller admitting them carries the obligation not to
 * enable thinking on the request. The public embed route is the one such caller: it passes
 * only temperature/maxTokens/stream, pinned by a test.
 */
export function inlinesReasoningIntoText(adapterFamily: string | null | undefined): boolean {
  if (!adapterFamily) return true;
  const channel = REASONING_CHANNEL_BY_ADAPTER_FAMILY[adapterFamily as AdapterFamily];
  return channel === undefined || channel === 'always';
}
