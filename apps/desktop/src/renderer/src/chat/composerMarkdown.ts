/**
 * Markdown awareness for the composer's plain textarea: where the code spans and fenced blocks
 * are, for ComposerHighlight to paint a code background behind, and what Enter and Tab mean
 * inside a fenced block.
 *
 * The textarea stays the source of truth and what is sent is the text exactly as it stands.
 * Every edit returned here is one the user could have typed by hand (a newline, a closing
 * fence, two spaces), applied by Composer through `insertText` so Cmd+Z undoes it like a
 * keystroke. Pure and separately tested, like composerInput.ts.
 *
 * Fences follow CommonMark closely enough for a chat box: up to three spaces of indent, three
 * or more backticks, an info string without backticks; a closing fence is at least as long as
 * the opening one and carries no info string. Tilde fences and multi-line inline spans are not
 * recognised, so they simply stay unpainted.
 */

const FENCE = /^ {0,3}(`{3,})([^`]*)$/;

/** Two spaces: what Tab inserts inside a block, and the most Shift+Tab takes off a line. */
export const INDENT = '  ';

type Fence = { ticks: number; info: string };

function fenceLine(line: string): Fence | null {
  const match = FENCE.exec(line);
  return match ? { ticks: match[1].length, info: match[2].trim() } : null;
}

function closes(fence: Fence, openTicks: number): boolean {
  return fence.ticks >= openTicks && fence.info === '';
}

function lineStartAt(text: string, offset: number): number {
  // lastIndexOf clamps a negative fromIndex to 0 and would then match a newline AT 0.
  return offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
}

function lineEndAt(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  return newline === -1 ? text.length : newline;
}

/** A code span or fenced block, as offsets into the draft (end exclusive). */
export type CodeRange = {
  kind: 'inline' | 'block';
  start: number;
  end: number;
};

/** Offset of the next run of exactly `width` backticks at or after `from`, or -1. */
function backtickRun(line: string, from: number, width: number): number {
  let index = from;
  while (index < line.length) {
    const at = line.indexOf('`', index);
    if (at === -1) return -1;
    let end = at;
    while (line[end] === '`') end++;
    if (end - at === width) return at;
    index = end;
  }
  return -1;
}

function inlineCode(line: string, offset: number): CodeRange[] {
  const ranges: CodeRange[] = [];
  let index = 0;
  while (index < line.length) {
    const open = line.indexOf('`', index);
    if (open === -1) break;
    let runEnd = open;
    while (line[runEnd] === '`') runEnd++;
    const width = runEnd - open;
    const close = backtickRun(line, runEnd, width);
    if (close === -1) {
      index = runEnd;
      continue;
    }
    ranges.push({ kind: 'inline', start: offset + open, end: offset + close + width });
    index = close + width;
  }
  return ranges;
}

/**
 * Every code span and fenced block in the draft, in order. A block runs from the start of its
 * opening fence line to the end of its closing one; a block still being typed runs to the end
 * of the draft, so it is painted as soon as the opening fence is there.
 */
export function codeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let open: { start: number; ticks: number } | null = null;
  let lineStart = 0;
  for (;;) {
    const lineEnd = lineEndAt(text, lineStart);
    const line = text.slice(lineStart, lineEnd);
    const fence = fenceLine(line);
    if (open) {
      if (fence && closes(fence, open.ticks)) {
        ranges.push({ kind: 'block', start: open.start, end: lineEnd });
        open = null;
      }
    } else if (fence) {
      open = { start: lineStart, ticks: fence.ticks };
    } else {
      ranges.push(...inlineCode(line, lineStart));
    }
    if (lineEnd === text.length) break;
    lineStart = lineEnd + 1;
  }
  if (open) ranges.push({ kind: 'block', start: open.start, end: text.length });
  return ranges;
}

/**
 * The fenced block open at `caret`, judged from the text before it only: the line the caret is
 * on counts up to the caret. So a caret just after a typed closing fence is outside the block,
 * and one just after a typed opening fence is inside it.
 */
function openFenceBefore(text: string, caret: number): { ticks: number; lineStart: number } | null {
  let open: { ticks: number; lineStart: number } | null = null;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf('\n', lineStart);
    const last = newline === -1 || newline >= caret;
    const fence = fenceLine(text.slice(lineStart, last ? caret : newline));
    if (open) {
      if (fence && closes(fence, open.ticks)) open = null;
    } else if (fence) {
      open = { ticks: fence.ticks, lineStart };
    }
    if (last) return open;
    lineStart = newline + 1;
  }
}

/** Whether the caret is inside a fenced block, where Enter and Tab take on their block meanings. */
export function caretInFencedBlock(text: string, caret: number): boolean {
  return openFenceBefore(text, caret) !== null;
}

/** Whether a block opened with `ticks` backticks is closed somewhere after `from`. */
function closedAfter(text: string, from: number, ticks: number): boolean {
  let lineStart = from;
  while (lineStart <= text.length) {
    const lineEnd = lineEndAt(text, lineStart);
    const fence = fenceLine(text.slice(lineStart, lineEnd));
    if (fence && closes(fence, ticks)) return true;
    if (lineEnd === text.length) return false;
    lineStart = lineEnd + 1;
  }
  return false;
}

/**
 * Whether the caret is in code: inside an open fenced block, or between the backticks of a
 * span. The `/` and `@` menus stay shut there, since a path or a decorator in code is not a
 * request for a skill or a session.
 */
export function caretInCode(
  text: string,
  caret: number,
  ranges: CodeRange[] = codeRanges(text),
  inBlock: boolean = caretInFencedBlock(text, caret),
): boolean {
  if (inBlock) return true;
  return ranges.some(range => range.kind === 'inline' && range.start < caret && caret < range.end);
}

/** Replace `start..end` with `insert`, then select `selectionStart..selectionEnd`. */
export type ComposerEdit = {
  start: number;
  end: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
};

export type FenceKeyAction =
  /** Send now: Cmd/Ctrl+Enter, the one way to send from inside an open block. */
  | { kind: 'submit' }
  /** Make this edit instead of the key's own. */
  | { kind: 'edit'; edit: ComposerEdit }
  /** Swallow the key and change nothing (Shift+Tab on a line with no indent to remove). */
  | { kind: 'consume' }
  /** Not a fence matter; the ordinary composer rules decide it. */
  | { kind: 'default' };

type KeyInput = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean };
type DraftInput = { text: string; selectionStart: number; selectionEnd: number };

function enterInFence(draft: DraftInput, open: { ticks: number; lineStart: number }): ComposerEdit {
  const { text, selectionStart, selectionEnd } = draft;
  const lineStart = lineStartAt(text, selectionStart);
  const indent = /^[ \t]*/.exec(text.slice(lineStart, selectionStart))?.[0] ?? '';
  const lineEnd = lineEndAt(text, selectionEnd);
  const onOpeningLine = open.lineStart === lineStart && selectionStart === selectionEnd;
  const restOfLineBlank = text.slice(selectionEnd, lineEnd).trim() === '';

  if (onOpeningLine && restOfLineBlank && !closedAfter(text, lineEnd + 1, open.ticks)) {
    // Enter at the end of a fresh ``` line: open the block and close it in one go, with the
    // caret on the empty line between, as an editor's bracket pairing does.
    const caret = selectionStart + 1 + indent.length;
    return {
      start: selectionStart,
      end: selectionEnd,
      insert: `\n${indent}\n${indent}${'`'.repeat(open.ticks)}`,
      selectionStart: caret,
      selectionEnd: caret,
    };
  }
  const caret = selectionStart + 1 + indent.length;
  return {
    start: selectionStart,
    end: selectionEnd,
    insert: `\n${indent}`,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

function outdentBy(line: string): number {
  if (line.startsWith('\t')) return 1;
  let count = 0;
  while (count < INDENT.length && line[count] === ' ') count++;
  return count;
}

function tabInFence(draft: DraftInput, outdent: boolean): FenceKeyAction {
  const { text, selectionStart, selectionEnd } = draft;
  if (!outdent && selectionStart === selectionEnd) {
    const caret = selectionStart + INDENT.length;
    return {
      kind: 'edit',
      edit: { start: selectionStart, end: selectionEnd, insert: INDENT, selectionStart: caret, selectionEnd: caret },
    };
  }

  const start = lineStartAt(text, selectionStart);
  // A selection ending at the very start of a line (after its newline) does not include that line.
  const lastOffset = selectionEnd > selectionStart && text[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const end = lineEndAt(text, lastOffset);
  const lines = text.slice(start, end).split('\n');
  const deltas = lines.map(line => (outdent ? -outdentBy(line) : INDENT.length));
  if (deltas.every(delta => delta === 0)) return { kind: 'consume' };

  const insert = lines.map((line, index) => (outdent ? line.slice(-deltas[index]) : INDENT + line)).join('\n');
  const total = deltas.reduce((sum, delta) => sum + delta, 0);
  const nextStart = Math.max(start, selectionStart + deltas[0]);
  const nextEnd = Math.max(nextStart, selectionEnd + total);
  return { kind: 'edit', edit: { start, end, insert, selectionStart: nextStart, selectionEnd: nextEnd } };
}

/**
 * What Enter and Tab mean while the caret is inside a fenced block.
 *
 * Enter breaks the line (keeping its indent) instead of sending, because a half-typed block is
 * the one draft nobody means to send yet; Cmd/Ctrl+Enter still sends. Tab indents and Shift+Tab
 * outdents. That takes Tab away from focus navigation inside a block only, so `tabReleased`
 * (set by Composer for the keypress straight after an Escape) hands it back: Escape then Tab
 * leaves the box, as in VS Code and CodeMirror. Outside a block everything is 'default'.
 */
export function fenceKeyAction(event: KeyInput, draft: DraftInput, tabReleased: boolean): FenceKeyAction {
  if (event.key !== 'Enter' && event.key !== 'Tab') return { kind: 'default' };
  const open = openFenceBefore(draft.text, draft.selectionStart);
  if (!open) return { kind: 'default' };

  if (event.key === 'Enter') {
    if (event.metaKey || event.ctrlKey) return { kind: 'submit' };
    if (event.shiftKey) return { kind: 'default' };
    return { kind: 'edit', edit: enterInFence(draft, open) };
  }

  if (tabReleased || event.metaKey || event.ctrlKey || event.altKey) return { kind: 'default' };
  return tabInFence(draft, event.shiftKey);
}
