const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Splits `<think>...</think>` spans out of reply text as it streams.
 *
 * The server inlines a model's reasoning into the text channel between these markers, and an
 * adaptive model (Opus 5) reasons on every turn whether or not thinking was asked for. The
 * replayable reasoning itself travels separately (`thinking` on the tool_use frame), so the
 * markers only ever reach the thread as noise - and, stored as the model's own words, get sent
 * back to it on every later round. Same rule as the web transcript: visibleReplyText in
 * @bike4mind/common's streamVisibility, which tracks nesting depth and treats a stray close as
 * text.
 *
 * Markers can split across deltas, so a tail that could still become one is held back until
 * the next push (or `flush`) settles it.
 */
export interface ThinkSplit {
  text: string;
  reasoning: string;
}

export function createThinkFilter(): { push(text: string): ThinkSplit; flush(): ThinkSplit } {
  let depth = 0;
  let pending = '';

  const drain = (final: boolean): ThinkSplit => {
    let visible = '';
    let reasoning = '';
    while (pending.length > 0) {
      const open = pending.indexOf(OPEN);
      const close = pending.indexOf(CLOSE);
      const next = [open, close].filter(index => index !== -1).sort((a, b) => a - b)[0];

      if (next === undefined) {
        const keep = final ? 0 : partialMarkerLength(pending);
        if (depth === 0) visible += pending.slice(0, pending.length - keep);
        else reasoning += pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        break;
      }

      if (depth === 0) visible += pending.slice(0, next);
      else reasoning += pending.slice(0, next);
      if (next === open) {
        depth += 1;
        pending = pending.slice(next + OPEN.length);
      } else {
        if (depth > 0) depth -= 1;
        else visible += CLOSE;
        pending = pending.slice(next + CLOSE.length);
      }
    }
    return { text: visible, reasoning };
  };

  return {
    push(text) {
      pending += text;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/** How many trailing characters of `text` are the start of a marker. */
function partialMarkerLength(text: string): number {
  for (let length = Math.min(CLOSE.length - 1, text.length); length > 0; length--) {
    const tail = text.slice(-length);
    if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return length;
  }
  return 0;
}
