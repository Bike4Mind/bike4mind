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
