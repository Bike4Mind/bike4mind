import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import type { ChatDiff } from '@shared/chat';
import { buildDiff } from './diff';
import { applyChunks, parsePatch, PatchParseError, type MatchLevel, type PatchOp } from './patch';
import { realpathNearest } from './paths';
import type { ApprovalPrompt, ToolContext, ToolDefinition } from './types';
import {
  assertNoControlCharacters,
  assertUnchanged,
  editSnippets,
  fingerprint,
  forget,
  MAX_WRITE_BYTES,
  readTarget,
  recordOwnWrite,
  remember,
  resolveWritablePath,
  sha,
  withPathLock,
  type TargetState,
} from './writeTools';

const MAX_PATCH_FILES = 100;
const MAX_SNIPPET_FILES = 8;

interface ResolvedOp {
  op: PatchOp;
  target: string;
  moveTarget?: string;
}

interface Entry {
  exists: boolean;
  content: string;
  /** Where the content came from when a Move to carried it here. */
  renamedFrom?: string;
}

interface FileChange {
  status: 'A' | 'M' | 'D' | 'R';
  /** The path as the model wrote it; a rename shows the destination. */
  display: string;
  from: string;
  to: string;
  beforeText: string;
  afterText: string;
  after: string;
  diff: ChatDiff;
}

interface PatchPlan {
  changes: FileChange[];
  /** Every file the patch touched, as it was on disk when planned. */
  disk: Map<string, TargetState>;
  key: string;
  notes: string[];
}

/** Whether a model gets apply_patch instead of file_edit and file_write. Mirrors opencode's rule. */
export function usesApplyPatch(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes('gpt-') && !id.includes('oss') && !id.includes('gpt-4');
}

const toLf = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

interface SplitText {
  lines: string[];
  crlf: boolean;
  bom: boolean;
  trailingNewline: boolean;
}

function splitText(raw: string): SplitText {
  const bom = raw.startsWith('\uFEFF');
  const text = bom ? raw.slice(1) : raw;
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfCount = (text.match(/\n/g) ?? []).length;
  const lf = text.replace(/\r\n/g, '\n');
  const lines = lf.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { lines, crlf: crlfCount > 0 && crlfCount >= lfCount - crlfCount, bom, trailingNewline: lf.endsWith('\n') };
}

function joinText(parts: SplitText): string {
  let body = parts.lines.join('\n');
  if (parts.lines.length > 0 && parts.trailingNewline) body += '\n';
  if (parts.crlf) body = body.replace(/\n/g, '\r\n');
  return parts.bom ? `\uFEFF${body}` : body;
}

const MATCH_NOTES: Record<MatchLevel, string> = {
  exact: '',
  trimEnd: 'trailing whitespace',
  trim: 'indentation',
  unicode: 'indentation or typographic punctuation',
};

function displayPath(target: string, context: ToolContext): string {
  const base = context.workingDirectory ?? context.roots[0];
  if (!base) return target;
  const rel = relative(base, target);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? target : rel.split('\\').join('/');
}

async function resolveOps(input: Record<string, unknown>, context: ToolContext): Promise<ResolvedOp[]> {
  const patchText = input.patchText;
  if (typeof patchText !== 'string' || patchText.trim() === '') {
    throw new Error('The "patchText" argument is required and must be a non-empty string.');
  }

  let ops: PatchOp[];
  try {
    ops = parsePatch(patchText);
  } catch (error) {
    if (error instanceof PatchParseError) throw new Error(`Invalid patch: ${error.message} Nothing was written.`);
    throw error;
  }
  if (ops.length === 0) throw new Error('The patch contains no file operations, so there is nothing to apply.');
  if (ops.length > MAX_PATCH_FILES) {
    throw new Error(`The patch has ${ops.length} file operations; the limit is ${MAX_PATCH_FILES} per call.`);
  }

  const resolved: ResolvedOp[] = [];
  for (const op of ops) {
    const target = await resolveWritablePath(op.path, context);
    const moveTarget = op.kind === 'update' && op.moveTo ? await resolveWritablePath(op.moveTo, context) : undefined;
    resolved.push({ op, target, ...(moveTarget ? { moveTarget } : {}) });
  }
  return resolved;
}

function planKey(resolved: readonly ResolvedOp[]): string {
  const parts = resolved.map(({ op, target, moveTarget }) =>
    JSON.stringify([
      op.kind,
      target,
      moveTarget ?? null,
      op.kind === 'add' ? op.lines : op.kind === 'update' ? op.chunks : null,
    ])
  );
  return `apply_patch\x00${sha(parts.join('\x01'))}`;
}

/**
 * Applies the whole patch to an in-memory view of the files, so every hunk is checked against
 * the result of the ones before it and nothing is written unless all of them locate.
 */
async function planPatch(resolved: readonly ResolvedOp[], context: ToolContext): Promise<PatchPlan> {
  const disk = new Map<string, TargetState>();
  const view = new Map<string, Entry>();
  const problems: string[] = [];
  const notes: string[] = [];

  const entryFor = async (target: string): Promise<Entry> => {
    const known = view.get(target);
    if (known) return known;
    const state = await readTarget(target, { allowBinary: true });
    disk.set(target, state);
    const entry: Entry = { exists: state.exists, content: state.content };
    view.set(target, entry);
    return entry;
  };

  const attempt = (label: string, task: () => void): boolean => {
    try {
      task();
      return true;
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  for (const { op, target, moveTarget } of resolved) {
    const display = displayPath(target, context);
    const entry = await entryFor(target);

    if (op.kind === 'add') {
      if (entry.exists) {
        problems.push(
          `${display}: Add File, but the file already exists. Use "*** Update File: ${op.path}" to change it, ` +
            'or delete it first in the same patch to replace it.'
        );
        continue;
      }
      attempt(display, () => {
        assertNoControlCharacters(op.lines.join('\n'), 'the added lines');
        const content = op.lines.length > 0 ? `${op.lines.join('\n')}\n` : '';
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
          throw new Error(`the new file is larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
        }
        entry.exists = true;
        entry.content = content;
      });
      continue;
    }

    if (op.kind === 'delete') {
      if (!entry.exists) {
        problems.push(`${display}: Delete File, but the file does not exist.`);
        continue;
      }
      entry.exists = false;
      entry.content = '';
      continue;
    }

    if (!entry.exists) {
      problems.push(
        `${display}: Update File, but the file does not exist. Use "*** Add File: ${op.path}" to create it.`
      );
      continue;
    }
    if (entry.content.includes('\u0000')) {
      problems.push(`${display}: looks like a binary file. Refusing to patch it as text.`);
      continue;
    }

    const split = splitText(entry.content);
    const applied = applyChunks(split.lines, op.chunks);
    if (applied.failures.length > 0) {
      for (const failure of applied.failures) problems.push(`${display}, ${failure.message}`);
      continue;
    }

    let content = '';
    const valid = attempt(display, () => {
      assertNoControlCharacters(op.chunks.flatMap(chunk => chunk.addedLines).join('\n'), 'the added lines');
      content = joinText({
        ...split,
        lines: applied.lines,
        trailingNewline: split.trailingNewline || split.lines.length === 0,
      });
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new Error(`the result would be larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
      }
    });
    if (!valid) continue;

    if (applied.loosest !== 'exact') {
      notes.push(
        `${display}: some hunks matched only after ignoring ${MATCH_NOTES[applied.loosest]}. ` +
          'Copy lines exactly as file_read shows them (without the line-number prefix).'
      );
    }

    if (moveTarget && moveTarget !== target) {
      const destination = await entryFor(moveTarget);
      if (destination.exists) {
        problems.push(`${display}: Move to ${displayPath(moveTarget, context)}, but that file already exists.`);
        continue;
      }
      destination.exists = true;
      destination.content = content;
      destination.renamedFrom = entry.renamedFrom ?? target;
      entry.exists = false;
      entry.content = '';
    } else {
      entry.content = content;
    }
  }

  if (problems.length > 0) {
    throw new Error(`The patch was not applied. Nothing was written.\n\n${problems.join('\n\n')}`);
  }

  return { changes: deriveChanges(view, disk, context), disk, key: planKey(resolved), notes };
}

function deriveChanges(
  view: ReadonlyMap<string, Entry>,
  disk: ReadonlyMap<string, TargetState>,
  context: ToolContext
): FileChange[] {
  const renamedAway = new Set([...view.values()].flatMap(entry => (entry.renamedFrom ? [entry.renamedFrom] : [])));
  const changes: FileChange[] = [];

  for (const [target, entry] of view) {
    const before = disk.get(target) ?? { exists: false, content: '' };
    const display = displayPath(target, context);
    const make = (
      status: FileChange['status'],
      from: string,
      beforeRaw: string,
      operation: ChatDiff['operation']
    ): void => {
      const beforeText = toLf(beforeRaw);
      const afterText = toLf(entry.content);
      const diff = buildDiff(target, operation, beforeText, afterText);
      changes.push({
        status,
        display,
        from,
        to: target,
        beforeText,
        afterText,
        after: entry.content,
        diff: status === 'R' ? { ...diff, movedFrom: from } : diff,
      });
    };

    if (entry.renamedFrom) {
      make('R', entry.renamedFrom, disk.get(entry.renamedFrom)?.content ?? '', 'edit');
    } else if (!entry.exists) {
      if (before.exists && !renamedAway.has(target)) {
        const beforeText = toLf(before.content);
        changes.push({
          status: 'D',
          display,
          from: target,
          to: target,
          beforeText,
          afterText: '',
          after: '',
          diff: buildDiff(target, 'delete', beforeText, ''),
        });
      }
    } else if (!before.exists) {
      make('A', target, '', 'create');
    } else if (before.content !== entry.content) {
      make('M', target, before.content, 'edit');
    }
  }
  return changes;
}

function totals(changes: readonly FileChange[]): { added: number; removed: number } {
  return changes.reduce(
    (sum, change) => ({ added: sum.added + change.diff.added, removed: sum.removed + change.diff.removed }),
    { added: 0, removed: 0 }
  );
}

function summaryLine(change: FileChange, context: ToolContext): string {
  const where = change.status === 'R' ? `${displayPath(change.from, context)} -> ${change.display}` : change.display;
  return `${change.status} ${where} (+${change.diff.added} -${change.diff.removed})`;
}

function headline(changes: readonly FileChange[]): string {
  const { added, removed } = totals(changes);
  return `${changes.length} file${changes.length === 1 ? '' : 's'} (+${added} -${removed})`;
}

function toPrompt(plan: PatchPlan, context: ToolContext): ApprovalPrompt {
  for (const [target, state] of plan.disk) {
    remember(`${plan.key}\x00${target}`, fingerprint(state.exists, state.content));
  }
  const detail = [
    `Apply patch to ${headline(plan.changes)}:`,
    ...plan.changes.map(c => `  ${summaryLine(c, context)}`),
  ].join('\n');
  const diffs = plan.changes.map(change => change.diff);
  return diffs.length === 1 ? { detail, key: plan.key, diff: diffs[0] } : { detail, key: plan.key, diffs };
}

async function restore(plan: PatchPlan, targets: readonly string[]): Promise<void> {
  for (const target of [...targets].reverse()) {
    const before = plan.disk.get(target);
    if (!before) continue;
    try {
      if (before.exists) await writeFile(target, before.content, 'utf8');
      else await unlink(target);
    } catch {
      // Already in the state we want, or unreachable; nothing better to do.
    }
  }
}

async function writeChanges(plan: PatchPlan): Promise<void> {
  const touched: string[] = [];
  try {
    for (const change of plan.changes) {
      if (change.status === 'D') {
        touched.push(change.to);
        await unlink(change.to);
        continue;
      }
      touched.push(change.to);
      await mkdir(dirname(change.to), { recursive: true });
      await writeFile(change.to, change.after, 'utf8');
      if (change.status === 'R' && change.from !== change.to) {
        touched.push(change.from);
        await unlink(change.from);
      }
    }
  } catch (error) {
    await restore(plan, touched);
    throw new Error(
      `Writing the patch failed part-way (${error instanceof Error ? error.message : String(error)}); ` +
        'every file was put back as it was.'
    );
  }
}

async function lockAll<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const [first, ...rest] = keys;
  if (first === undefined) return task();
  return withPathLock(first, () => lockAll(rest, task));
}

async function runPatch(input: Record<string, unknown>, context: ToolContext): Promise<string> {
  const resolved = await resolveOps(input, context);
  const targets = resolved.flatMap(entry => (entry.moveTarget ? [entry.target, entry.moveTarget] : [entry.target]));
  // Sorted, so two patches that share files take their locks in the same order.
  const keys = [...new Set(await Promise.all(targets.map(realpathNearest)))].sort();

  return lockAll(keys, async () => {
    // Re-resolved under the lock: a root can be revoked while the prompt is on screen.
    const fresh = await resolveOps(input, context);
    const plan = await planPatch(fresh, context);
    if (plan.changes.length === 0) {
      for (const target of plan.disk.keys()) forget(`${plan.key}\x00${target}`);
      return 'No change made: the patch leaves every file as it already is.';
    }

    for (const [target, state] of plan.disk) {
      assertUnchanged(`${plan.key}\x00${target}`, target, fingerprint(state.exists, state.content));
    }
    if (context.signal.aborted) throw new Error('The turn was stopped before this change was written.');

    await writeChanges(plan);

    for (const change of plan.changes) {
      const source = plan.disk.get(change.from);
      const was = plan.disk.get(change.to);
      recordOwnWrite(
        change.to,
        fingerprint(was?.exists ?? false, was?.content ?? ''),
        fingerprint(change.status !== 'D', change.after)
      );
      if (change.status === 'R' && source) {
        recordOwnWrite(change.from, fingerprint(true, source.content), fingerprint(false, ''));
      }
    }
    for (const target of plan.disk.keys()) forget(`${plan.key}\x00${target}`);

    // After the writes, for the reason applyPlan in writeTools gives: a diff under a write that
    // never happened would be a false record.
    for (const change of plan.changes) context.report?.diff(change.diff);
    context.report?.label(
      plan.changes.length === 1
        ? `${plan.changes[0].status === 'A' ? 'Created' : plan.changes[0].status === 'D' ? 'Deleted' : 'Patched'} ${plan.changes[0].display}`
        : `Edited ${plan.changes.length} files`
    );

    return describeResult(plan, context);
  });
}

function describeResult(plan: PatchPlan, context: ToolContext): string {
  const lines = [`Applied patch to ${headline(plan.changes)}:`, ...plan.changes.map(c => summaryLine(c, context))];
  if (plan.notes.length > 0) lines.push(...plan.notes);

  const edited = plan.changes.filter(change => change.status === 'M' || change.status === 'R');
  edited.slice(0, MAX_SNIPPET_FILES).forEach(change => {
    const snippets = editSnippets(change.beforeText, change.afterText);
    if (snippets) lines.push('', `${change.display}:${snippets}`);
  });
  if (edited.length > MAX_SNIPPET_FILES) lines.push('', '[Edited regions of more files not shown.]');
  return lines.join('\n');
}

const DESCRIPTION = [
  'Edit files with a patch. This is the only tool for changing, creating, moving or deleting files.',
  '',
  'The patch is a stripped-down, file-oriented diff inside an envelope:',
  '',
  '*** Begin Patch',
  '[ one or more file sections ]',
  '*** End Patch',
  '',
  'Every file section starts with one of three headers:',
  '',
  '*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).',
  '*** Delete File: <path> - remove an existing file. Nothing follows.',
  '*** Update File: <path> - patch an existing file in place, optionally renamed with a following',
  '*** Move to: <new path> line.',
  '',
  'An Update File section holds one or more hunks. A hunk is an optional "@@ <line>" header naming a',
  'line of the file that sits just above the change (a function or class signature, say), then the',
  'lines themselves: " " (a space) for unchanged context, "-" for a line to remove, "+" for a line to',
  'add. Show about 3 lines of context above and below each change, enough to make the place unique.',
  'Hunks are matched against the file from top to bottom, so list them in the order they appear in',
  'the file. Use several "@@" lines to nest a scope (a class, then a method). Mark a hunk that edits',
  'the end of the file with "*** End of File" after its last line.',
  '',
  'Example:',
  '',
  '*** Begin Patch',
  '*** Add File: hello.txt',
  '+Hello world',
  '*** Update File: src/app.py',
  '*** Move to: src/main.py',
  '@@ def greet():',
  '-print("Hi")',
  '+print("Hello, world!")',
  '*** Delete File: obsolete.txt',
  '*** End Patch',
  '',
  'Important:',
  '- Every file section needs one of the three headers; new lines are prefixed with + even in a new file.',
  '- Paths are relative to the working folder, or absolute. Only folders the user has shared can be changed.',
  '- Copy context and removed lines exactly as file_read shows them, WITHOUT the line-number prefix.',
  '- Put every change you have planned, across all files, in one call. The patch is all-or-nothing: if any',
  '  hunk cannot be located nothing is written, and the error names the hunk and where the file differs.',
  '- Read a file before you update it. Updating or deleting a missing file, or adding an existing one, is an error.',
  '- The user approves a diff of every file before anything is written.',
].join('\n');

export const applyPatch: ToolDefinition = {
  schema: {
    name: 'apply_patch',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        patchText: {
          type: 'string',
          description:
            'The full patch text that describes all changes to be made, from *** Begin Patch to *** End Patch.',
        },
      },
      required: ['patchText'],
      additionalProperties: false,
    },
  },

  async needsApproval(input, context) {
    return (await planPatch(await resolveOps(input, context), context)).changes.length > 0;
  },

  async approval(input, context) {
    return toPrompt(await planPatch(await resolveOps(input, context), context), context);
  },

  run: runPatch,
};
