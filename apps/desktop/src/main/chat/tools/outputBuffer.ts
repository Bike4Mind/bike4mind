export type OutputStream = 'stdout' | 'stderr';

interface Entry {
  stream: OutputStream;
  text: string;
  /** Absolute offset, in characters, of the first character of `text`. */
  offset: number;
}

export interface OutputSlice {
  text: string;
  /** Read from here next time to get only what arrives after this slice. */
  cursor: number;
  /** Characters the reader missed because the cap discarded them before it read. */
  missed: number;
}

/**
 * A background command's output, capped and read by cursor.
 *
 * A watcher emits megabytes over an afternoon, and every character the model reads it pays for
 * again on every later turn - the completions endpoint is stateless. So this keeps a bounded
 * TAIL: the newest output is what anyone wants from a long-running process, and the oldest is
 * dropped rather than growing without limit.
 *
 * Offsets are absolute and never reset, so a reader's cursor stays meaningful after a trim -
 * it just lands below `start`, which is exactly how a gap is detected and reported.
 */
export class OutputBuffer {
  private entries: Entry[] = [];
  /** Absolute offset of the oldest retained character. */
  private start = 0;
  /** Absolute offset one past the newest character. */
  private end = 0;
  private retained = 0;
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  get cursor(): number {
    return this.end;
  }

  get retainedChars(): number {
    return this.retained;
  }

  get droppedChars(): number {
    return this.dropped;
  }

  push(stream: OutputStream, text: string): void {
    if (!text) return;
    this.entries.push({ stream, text, offset: this.end });
    this.end += text.length;
    this.retained += text.length;
    this.trim();
  }

  /**
   * Everything since `from`. A `from` below the retained window means output was dropped in
   * between; `missed` says how much, so the model is told about the gap rather than being
   * handed a tail that silently pretends to be contiguous.
   */
  read(from: number, maxChars: number): OutputSlice {
    const missedByTrim = Math.max(0, this.start - from);
    const begin = Math.max(from, this.start);
    const full = this.render(begin, this.end);

    if (full.length <= maxChars) return { text: full, cursor: this.end, missed: missedByTrim };

    const kept = full.slice(full.length - maxChars);
    return { text: kept, cursor: this.end, missed: missedByTrim + (full.length - maxChars) };
  }

  /** The newest `maxChars` characters, ignoring any cursor. */
  tail(maxChars: number): string {
    return this.read(this.start, maxChars).text;
  }

  /**
   * Flatten the window into text in arrival order.
   *
   * Stream markers are added only when BOTH streams appear in the window: a dev server that
   * logs everything to stderr would otherwise have a useless `[stderr]` stapled to every line,
   * while a command that genuinely mixes them is unreadable without knowing which is which.
   */
  private render(begin: number, finish: number): string {
    const visible = this.entries.filter(entry => entry.offset + entry.text.length > begin && entry.offset < finish);
    if (visible.length === 0) return '';

    const mixed = visible.some(entry => entry.stream === 'stdout') && visible.some(entry => entry.stream === 'stderr');

    let out = '';
    let previous: OutputStream | null = null;
    for (const entry of visible) {
      const from = Math.max(0, begin - entry.offset);
      const to = Math.min(entry.text.length, finish - entry.offset);
      const slice = entry.text.slice(from, to);
      if (!slice) continue;
      if (mixed && entry.stream !== previous) {
        out += `${out && !out.endsWith('\n') ? '\n' : ''}[${entry.stream}]\n`;
        previous = entry.stream;
      }
      out += slice;
    }
    return out;
  }

  /** Drop whole entries first, then split the oldest survivor, so `start` is always exact. */
  private trim(): void {
    while (this.retained > this.capacity && this.entries.length > 0) {
      const oldest = this.entries[0];
      const excess = this.retained - this.capacity;

      if (oldest.text.length <= excess) {
        this.entries.shift();
        this.retained -= oldest.text.length;
        this.dropped += oldest.text.length;
        this.start = oldest.offset + oldest.text.length;
        continue;
      }

      oldest.text = oldest.text.slice(excess);
      oldest.offset += excess;
      this.retained -= excess;
      this.dropped += excess;
      this.start = oldest.offset;
    }
  }
}
