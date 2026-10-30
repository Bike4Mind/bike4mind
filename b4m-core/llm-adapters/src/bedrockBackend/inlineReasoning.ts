import { createThinkMarkerEscaper } from '@bike4mind/common';

export interface InlineReasoningScanner {
  /** Returns the text safe to emit now; a possible partial tag stays buffered. */
  push(text: string): string;
  /** Emits whatever is buffered and closes an open span. Call at content-block or stream end. */
  flush(): string;
}

function partialSuffixLength(text: string, tag: string): number {
  for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * Rewrites `<tag>...</tag>` spans in model text into `<think>...</think>` spans, the same
 * shape reasoningContent blocks produce. With dropReasoning the spans are removed entirely.
 */
export function createInlineReasoningScanner(tag: string, dropReasoning: boolean): InlineReasoningScanner {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const escaper = createThinkMarkerEscaper();
  let inside = false;
  let pending = '';
  let trimLeading = false;

  const push = (text: string): string => {
    let buf = pending + text;
    pending = '';
    let out = '';
    while (buf) {
      if (!inside) {
        if (trimLeading) {
          buf = buf.trimStart();
          if (!buf) break;
          trimLeading = false;
        }
        const idx = buf.indexOf(open);
        if (idx >= 0) {
          out += buf.slice(0, idx);
          buf = buf.slice(idx + open.length);
          inside = true;
          if (!dropReasoning) out += '<think>';
          continue;
        }
        const hold = partialSuffixLength(buf, open);
        out += buf.slice(0, buf.length - hold);
        pending = buf.slice(buf.length - hold);
        break;
      }
      const idx = buf.indexOf(close);
      if (idx >= 0) {
        if (!dropReasoning) out += escaper.push(buf.slice(0, idx)) + escaper.flush() + '</think>';
        buf = buf.slice(idx + close.length);
        inside = false;
        trimLeading = true;
        continue;
      }
      const hold = partialSuffixLength(buf, close);
      if (!dropReasoning) out += escaper.push(buf.slice(0, buf.length - hold));
      pending = buf.slice(buf.length - hold);
      break;
    }
    return out;
  };

  const flush = (): string => {
    const rest = pending;
    pending = '';
    let out = '';
    if (inside) {
      if (!dropReasoning) out += escaper.push(rest) + escaper.flush() + '</think>';
      inside = false;
    } else {
      out += rest;
    }
    trimLeading = false;
    return out;
  };

  return { push, flush };
}
