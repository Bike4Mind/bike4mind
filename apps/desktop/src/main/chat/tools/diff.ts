import type { ChatDiff, ChatDiffLine } from '@shared/chat';

/** Unchanged lines kept either side of a change, so the user can see where it lands. */
const CONTEXT_LINES = 3;

/** Ceiling on rendered lines. A 4000-line rewrite is not read line by line, it is read as a shape. */
const MAX_DIFF_LINES = 400;

/**
 * Above this, an exact line LCS costs more than the precision buys: the table is quadratic,
 * and a change that large is shown as a whole-block replacement instead.
 */
const MAX_LCS_LINES = 1500;

/**
 * Split for display. A trailing newline is a terminator, not an empty final line, so it is
 * dropped - otherwise every file ends with a phantom blank line in the diff.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Op {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Longest common subsequence of two line arrays, walked back into a line-by-line script. */
function lcsOps(before: string[], after: string[], oldStart: number, newStart: number): Op[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'context', text: before[i], oldLine: oldStart + i, newLine: newStart + j });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ kind: 'remove', text: before[i], oldLine: oldStart + i });
      i++;
    } else {
      ops.push({ kind: 'add', text: after[j], newLine: newStart + j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'remove', text: before[i], oldLine: oldStart + i });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: after[j], newLine: newStart + j });
    j++;
  }
  return ops;
}

/**
 * Line operations turning `before` into `after`.
 *
 * Common prefix and suffix are trimmed first. That is not only a speed trick: it keeps a
 * one-line change in the middle of a long file from being re-derived as some arbitrary
 * subsequence that happens to be just as long.
 */
export function diffLines(before: string[], after: string[]): { ops: Op[]; approximate: boolean } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const head: Op[] = before
    .slice(0, prefix)
    .map((text, index) => ({ kind: 'context' as const, text, oldLine: index + 1, newLine: index + 1 }));
  const tail: Op[] = before.slice(before.length - suffix).map((text, index) => ({
    kind: 'context' as const,
    text,
    oldLine: before.length - suffix + index + 1,
    newLine: after.length - suffix + index + 1,
  }));

  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);

  if (middleBefore.length === 0 && middleAfter.length === 0) {
    return { ops: [...head, ...tail], approximate: false };
  }

  if (Math.max(middleBefore.length, middleAfter.length) > MAX_LCS_LINES) {
    const middle: Op[] = [
      ...middleBefore.map((text, index) => ({ kind: 'remove' as const, text, oldLine: prefix + index + 1 })),
      ...middleAfter.map((text, index) => ({ kind: 'add' as const, text, newLine: prefix + index + 1 })),
    ];
    return { ops: [...head, ...middle, ...tail], approximate: true };
  }

  return { ops: [...head, ...lcsOps(middleBefore, middleAfter, prefix + 1, prefix + 1), ...tail], approximate: false };
}

/** Which ops are worth showing: every change, plus `CONTEXT_LINES` of unchanged either side. */
function keptIndexes(ops: readonly Op[]): boolean[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === 'context') return;
    for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(ops.length - 1, index + CONTEXT_LINES); i++) {
      keep[i] = true;
    }
  });
  return keep;
}

/**
 * The change as the approval prompt shows it.
 *
 * `beforeText` is what is on disk right now and `afterText` is what the tool would put there,
 * so this is only honest while the file stays unchanged - which is why the write tools
 * re-check the file against this snapshot before they write.
 */
export function buildDiff(
  path: string,
  operation: ChatDiff['operation'],
  beforeText: string,
  afterText: string
): ChatDiff {
  const { ops, approximate } = diffLines(splitLines(beforeText), splitLines(afterText));

  const added = ops.filter(op => op.kind === 'add').length;
  const removed = ops.filter(op => op.kind === 'remove').length;

  const keep = keptIndexes(ops);
  const lines: ChatDiffLine[] = [];
  let skipped = 0;

  const flushGap = () => {
    if (skipped === 0) return;
    lines.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
    skipped = 0;
  };

  for (let index = 0; index < ops.length && lines.length < MAX_DIFF_LINES; index++) {
    if (!keep[index]) {
      skipped++;
      continue;
    }
    flushGap();
    const op = ops[index];
    lines.push({
      kind: op.kind,
      text: op.text,
      ...(op.oldLine === undefined ? {} : { oldLine: op.oldLine }),
      ...(op.newLine === undefined ? {} : { newLine: op.newLine }),
    });
  }
  flushGap();

  const truncated = approximate || lines.length >= MAX_DIFF_LINES;
  return { path, operation, added, removed, lines, ...(truncated ? { truncated: true } : {}) };
}

/** The headline above the diff, and the line the model is given back once the write lands. */
export function summarizeDiff(diff: ChatDiff): string {
  const verb = diff.operation === 'create' ? 'Create' : diff.operation === 'overwrite' ? 'Overwrite' : 'Edit';
  return `${verb} ${diff.path}  (+${diff.added} -${diff.removed})`;
}
