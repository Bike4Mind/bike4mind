const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagLength(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Incremental counterpart of `stripThinkingBlocks`: fed a text stream chunk by
 * chunk, it releases only the text the user should see, as early as that is
 * unambiguous. The concatenation of every `push` plus `end` equals
 * `stripThinkingBlocks(wholeText)` for any chunking (pinned by its tests), so a
 * streamed turn and a buffered one deliver identical text:
 *
 * - `<think>...</think>` blocks are dropped; an unclosed block is released
 *   verbatim at `end`, as the regex leaves it in place;
 * - a chunk ending in a possible tag prefix (`<thi`) is held until resolved;
 * - leading whitespace is dropped and trailing whitespace is held until more
 *   visible text follows, mirroring the final `trim()`.
 */
export class VisibleTextFilter {
  private insideThinkBlock = false;
  // Unresolved input: a possible tag prefix, or the body of an open think block.
  private held = '';
  private pendingWhitespace = '';
  private releasedAny = false;

  /** Feed the next chunk; returns the newly visible text (possibly empty). */
  push(chunk: string): string {
    let buffer = this.held + chunk;
    let visible = '';

    for (;;) {
      if (this.insideThinkBlock) {
        const closeAt = buffer.indexOf(CLOSE_TAG);
        if (closeAt < 0) {
          this.held = buffer;
          break;
        }
        buffer = buffer.slice(closeAt + CLOSE_TAG.length);
        this.insideThinkBlock = false;
        continue;
      }

      const openAt = buffer.indexOf(OPEN_TAG);
      if (openAt < 0) {
        const heldLength = partialTagLength(buffer, OPEN_TAG);
        visible += buffer.slice(0, buffer.length - heldLength);
        this.held = buffer.slice(buffer.length - heldLength);
        break;
      }
      visible += buffer.slice(0, openAt);
      buffer = buffer.slice(openAt + OPEN_TAG.length);
      this.insideThinkBlock = true;
    }

    return this.release(visible);
  }

  /** Flush at end of stream; returns whatever visible text was still held. */
  end(): string {
    const unresolved = this.insideThinkBlock ? OPEN_TAG + this.held : this.held;
    this.held = '';
    this.insideThinkBlock = false;
    return this.release(unresolved);
  }

  private release(text: string): string {
    const candidate = this.releasedAny ? this.pendingWhitespace + text : text.trimStart();
    const body = candidate.trimEnd();
    if (!body) {
      if (this.releasedAny) this.pendingWhitespace = candidate;
      return '';
    }
    this.releasedAny = true;
    this.pendingWhitespace = candidate.slice(body.length);
    return body;
  }
}
