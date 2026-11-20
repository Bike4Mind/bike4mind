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
 * `startInReasoning` swaps in a different rule (see prefilledFilter): the first close ends the
 * reasoning and later markers are reply text.
 *
 * Markers can split across deltas, so a tail that could still become one is held back until
 * the next push (or `flush`) settles it.
 */
export interface ThinkSplit {
  text: string;
  reasoning: string;
}

type ThinkFilter = { push(text: string): ThinkSplit; flush(): ThinkSplit };

/**
 * `startInReasoning`: the prompt already opened the block (a template that prefills `<think>`).
 * Splits the way Ollama's own thinking parser does for such a prompt, see prefilledFilter.
 */
export function createThinkFilter({ startInReasoning = false }: { startInReasoning?: boolean } = {}): ThinkFilter {
  if (startInReasoning) return prefilledFilter();
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

/**
 * Mirrors Ollama's thinking parser (thinking/parser.go) started inside the block: leading
 * whitespace is dropped, reasoning runs verbatim to the first `</think>`, whitespace after it is
 * dropped, and everything after that is reply text, later markers included.
 */
function prefilledFilter(): ThinkFilter {
  let state: 'leading' | 'reasoning' | 'trailing' | 'reply' = 'leading';
  let pending = '';

  const drain = (final: boolean): ThinkSplit => {
    let reasoning = '';
    let text = '';
    if (state === 'leading') {
      pending = pending.trimStart();
      if (pending) state = 'reasoning';
    }
    if (state === 'reasoning') {
      const close = pending.indexOf(CLOSE);
      if (close === -1) {
        const keep = final ? 0 : closeOverlap(pending);
        reasoning = pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        return { text, reasoning };
      }
      reasoning = pending.slice(0, close);
      pending = pending.slice(close + CLOSE.length);
      state = 'trailing';
    }
    if (state === 'trailing') {
      pending = pending.trimStart();
      if (pending) state = 'reply';
    }
    if (state === 'reply') {
      text = pending;
      pending = '';
    }
    return { text, reasoning };
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

/** How many trailing characters of `text` could still become `</think>`. */
function closeOverlap(text: string): number {
  for (let length = Math.min(CLOSE.length - 1, text.length); length > 0; length--) {
    if (CLOSE.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

/** How many trailing characters of `text` are the start of a marker. */
function partialMarkerLength(text: string): number {
  for (let length = Math.min(CLOSE.length - 1, text.length); length > 0; length--) {
    const tail = text.slice(-length);
    if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return length;
  }
  return 0;
}
