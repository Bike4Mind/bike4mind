import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatDiff } from '@shared/chat';
import { buildDiff, splitLines, summarizeDiff } from './diff';
import { isWithin, PathAccessDenied, realpathNearest, resolveWithinRoots } from './paths';
import { credentialPaths } from './sandbox';
import { requireString, type ApprovalPrompt, type ToolContext, type ToolDefinition } from './types';

/**
 * Ceiling on both the file being replaced and the content replacing it. A write the user
 * cannot meaningfully read in a diff is one they cannot meaningfully consent to, and holding
 * two copies of a huge file in memory to diff them is its own problem.
 */
const MAX_WRITE_BYTES = 1_000_000;

/**
 * Where `path` may be written, or a refusal.
 *
 * Two checks, and both matter:
 *  - `resolveWithinRoots` proves the target's real path is inside a folder the user granted,
 *    so a symlink or `..` cannot walk out of one;
 *  - the protected list then wins over the grant. Granting the home folder must not hand the
 *    model a write into this app's own userData (the token vault) or into ~/.ssh.
 *
 * Called at approval time AND again at execution time. The second call is the one that counts:
 * a root can be revoked, or a path replaced with a symlink, while the prompt is on screen.
 */
async function resolveWritablePath(requested: string, context: ToolContext): Promise<string> {
  const target = await resolveWithinRoots(requested, context.roots, context.workingDirectory);
  const real = await realpathNearest(target);

  for (const guarded of [...(context.protectedPaths ?? []), ...credentialPaths()]) {
    if (isWithin(guarded, real) || isWithin(guarded, target)) {
      throw new PathAccessDenied(
        requested,
        `Refused: ${requested} is a protected location and cannot be written to, ` +
          'whatever folders are shared. Choose a different path.'
      );
    }
  }

  return target;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Identity of the file as it was when the diff was built. 'absent' is not the same as empty. */
function fingerprint(exists: boolean, content: string): string {
  return exists ? sha(content) : 'absent';
}

/**
 * The file as it was when the user was shown the diff, keyed by the same approval key the gate
 * uses. Approving a diff is consent to THAT change; if the file moved underneath it the diff
 * no longer describes what would happen, so the write is refused rather than applied blind.
 *
 * Entries are dropped once used, and the map is bounded - a denied or abandoned approval must
 * not pin a fingerprint for the life of the process.
 */
const approvedState = new Map<string, string>();
const MAX_REMEMBERED = 50;

function remember(key: string, state: string): void {
  if (approvedState.size >= MAX_REMEMBERED) {
    const oldest = approvedState.keys().next().value;
    if (oldest !== undefined) approvedState.delete(oldest);
  }
  approvedState.set(key, state);
}

/**
 * What each write this module made replaced, keyed by the target and the fingerprint it left
 * behind. Lets a stale approval be traced back through this app's own writes: two approved
 * edits to one file in a single round both saw the original, and the second must still apply
 * on top of the first rather than be refused as if someone else had touched the file.
 */
const ownWrites = new Map<string, string>();
const MAX_OWN_WRITES = 200;

function recordOwnWrite(target: string, before: string, after: string): void {
  if (ownWrites.size >= MAX_OWN_WRITES) {
    const oldest = ownWrites.keys().next().value;
    if (oldest !== undefined) ownWrites.delete(oldest);
  }
  ownWrites.set(`${target}\x00${after}`, before);
}

/** Whether `current` is `approved`, or was reached from it by this module's writes alone. */
function descendsFrom(target: string, approved: string, current: string): boolean {
  const seen = new Set<string>();
  for (let state: string | undefined = current; state !== undefined && !seen.has(state);) {
    if (state === approved) return true;
    seen.add(state);
    state = ownWrites.get(`${target}\x00${state}`);
  }
  return false;
}

/** Reject a stale approval. Absent state means no gate ran, which the gate itself decides. */
function assertUnchanged(key: string, target: string, current: string): void {
  const approved = approvedState.get(key);
  if (approved !== undefined && !descendsFrom(target, approved, current)) {
    throw new Error(
      `${target} changed on disk after the user approved this change, so the change they saw no ` +
        'longer applies. Read the file again and propose the edit against its current contents.'
    );
  }
}

/**
 * Write tools run one at a time per file. The model issues a round's calls in parallel, and two
 * edits to one file would otherwise both read the original, the later write silently dropping
 * the earlier edit - or, with both writes in flight at once, tearing the file.
 */
const pathLocks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  pathLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (pathLocks.get(key) === current) pathLocks.delete(key);
  }
}

/** Plans against the file as it is once every earlier write to it has landed, then applies. */
async function planAndApply(
  input: Record<string, unknown>,
  context: ToolContext,
  plan: (input: Record<string, unknown>, context: ToolContext) => Promise<WritePlan>
): Promise<string> {
  const target = await resolveWritablePath(requireString(input, 'path'), context);
  // The real path, so two spellings of one file (a symlinked folder) share a lock.
  return withPathLock(await realpathNearest(target), async () => applyPlan(await plan(input, context), context));
}

function requireText(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  // Not `requireString`: an empty string is a legitimate file body, and a legitimate deletion.
  if (typeof value !== 'string') throw new Error(`The "${key}" argument is required and must be a string.`);
  return value;
}

interface TargetState {
  exists: boolean;
  content: string;
}

async function readTarget(target: string): Promise<TargetState> {
  let info;
  try {
    info = await stat(target);
  } catch {
    return { exists: false, content: '' };
  }

  if (info.isDirectory()) throw new Error(`${target} is a directory, not a file.`);
  if (!info.isFile()) throw new Error(`${target} is not a regular file, so it cannot be rewritten.`);
  if (info.size > MAX_WRITE_BYTES) {
    throw new Error(`${target} is ${info.size} bytes, too large to diff and rewrite safely.`);
  }

  const content = await readFile(target, 'utf8');
  // A NUL byte means the "text" round trip would corrupt the file, and the diff shown to the
  // user would be meaningless anyway.
  if (content.includes('\u0000')) {
    throw new Error(`${target} looks like a binary file. Refusing to rewrite it as text.`);
  }
  return { exists: true, content };
}

interface WritePlan {
  target: string;
  state: TargetState;
  after: string;
  diff: ChatDiff;
  key: string;
}

/**
 * Everything both `approval` and `run` need, derived from the input and the CURRENT file.
 *
 * Deliberately recomputed rather than cached between the two: `run` must re-check containment
 * and re-read the file, not trust what was true when the prompt was raised.
 */
async function planWrite(input: Record<string, unknown>, context: ToolContext): Promise<WritePlan> {
  const requested = requireString(input, 'path');
  const after = requireText(input, 'content');
  if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`"content" is larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
  }

  const target = await resolveWritablePath(requested, context);
  const state = await readTarget(target);
  const diff = buildDiff(target, state.exists ? 'overwrite' : 'create', state.content, after);

  return { target, state, after, diff, key: `file_write\x00${target}\x00${sha(after)}` };
}

const MAX_BATCH_EDITS = 50;

interface EditSpec {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

/** The single-edit form and the `edits` batch, normalised to one list. */
function readEdits(input: Record<string, unknown>): { edits: EditSpec[]; batch: boolean } {
  if (input.edits === undefined) {
    return {
      edits: [
        {
          oldText: requireString(input, 'oldText'),
          newText: requireText(input, 'newText'),
          replaceAll: input.replaceAll === true,
        },
      ],
      batch: false,
    };
  }

  if (input.oldText !== undefined || input.newText !== undefined || input.replaceAll !== undefined) {
    throw new Error('Pass either "edits" or the single oldText/newText form, not both.');
  }
  const raw = input.edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"edits" must be a non-empty array of { oldText, newText, replaceAll? } objects.');
  }
  if (raw.length > MAX_BATCH_EDITS) {
    throw new Error(`"edits" has ${raw.length} entries; the limit is ${MAX_BATCH_EDITS} per call.`);
  }

  const edits = raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`edits[${index}] must be an object with "oldText" and "newText".`);
    }
    const record = entry as Record<string, unknown>;
    try {
      return {
        oldText: requireString(record, 'oldText'),
        newText: requireText(record, 'newText'),
        replaceAll: record.replaceAll === true,
      };
    } catch (error) {
      throw new Error(`edits[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { edits, batch: true };
}

/** Applies one edit to `content`, or throws. `label` names the edit in a batch, empty for a lone edit. */
function applyEdit(content: string, edit: EditSpec, target: string, label: string): string {
  const { oldText, newText, replaceAll } = edit;
  const subject = label ? `${label}: "oldText"` : '"oldText"';

  const occurrences = countOccurrences(content, oldText);
  if (occurrences === 0) {
    throw new Error(
      `${subject} does not appear in ${target}${label ? ' as it stands after the earlier edits' : ''}. ` +
        'Read the file and copy the exact text to replace, including its indentation and line breaks.'
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `${subject} appears ${occurrences} times in ${target}, so the edit is ambiguous. Include ` +
        'enough surrounding lines to make it unique, or pass replaceAll: true to change every one.'
    );
  }
  if (oldText === newText) {
    throw new Error(
      `${label ? `${label}: ` : ''}"newText" is identical to "oldText", so this edit would change nothing.`
    );
  }

  // A function replacement, because `$&` and friends in a plain replacement string would be
  // expanded - silently corrupting any edit whose new text contains a dollar sign.
  return replaceAll ? content.replaceAll(oldText, () => newText) : content.replace(oldText, () => newText);
}

async function planEdit(input: Record<string, unknown>, context: ToolContext): Promise<WritePlan> {
  const requested = requireString(input, 'path');
  const { edits, batch } = readEdits(input);

  const target = await resolveWritablePath(requested, context);
  const state = await readTarget(target);
  if (!state.exists) {
    throw new Error(`${target} does not exist. Use file_write to create it.`);
  }

  // All in memory and in order, each against the previous result: nothing is written unless
  // every edit applies, so a failure at edit N leaves the file exactly as it was.
  let after = state.content;
  edits.forEach((edit, index) => {
    const label = batch ? `edits[${index}] (edit ${index + 1} of ${edits.length}, nothing was written)` : '';
    after = applyEdit(after, edit, target, label);
  });
  if (after === state.content) {
    throw new Error('The edits cancel each other out, so this call would change nothing.');
  }
  if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`The result would be larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
  }

  const diff = buildDiff(target, 'edit', state.content, after);
  const editsKey = edits.map(e => `${sha(e.oldText)}\x00${sha(e.newText)}\x00${e.replaceAll}`).join('\x01');
  return { target, state, after, diff, key: `file_edit\x00${target}\x00${editsKey}` };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function toPrompt(plan: WritePlan): ApprovalPrompt {
  remember(plan.key, fingerprint(plan.state.exists, plan.state.content));
  return { detail: summarizeDiff(plan.diff), key: plan.key, diff: plan.diff };
}

/** Applies an already-planned change, after one last check that the plan still holds. */
async function applyPlan(plan: WritePlan, context: ToolContext): Promise<string> {
  assertUnchanged(plan.key, plan.target, fingerprint(plan.state.exists, plan.state.content));
  if (context.signal.aborted) throw new Error('The turn was stopped before this change was written.');

  // Recursive, but the target is already proven to sit inside a granted root, so every parent
  // this creates is inside it too.
  await mkdir(dirname(plan.target), { recursive: true });
  await writeFile(plan.target, plan.after, 'utf8');
  recordOwnWrite(plan.target, fingerprint(plan.state.exists, plan.state.content), fingerprint(true, plan.after));
  approvedState.delete(plan.key);

  // AFTER the write, deliberately: everything above can throw - a revoked root, a stale
  // approval, a stopped turn - and a transcript row showing a diff for a write that never
  // happened would be worse than one showing none. The diff is the plan rather than a re-read
  // of the file because the plan is what was written, under this path's lock, having just
  // checked the file still matched it; re-reading now would pick up whoever wrote next.
  context.report?.diff(plan.diff);

  const lines = splitLines(plan.after).length;
  return `${summarizeDiff(plan.diff)}\nWritten. ${plan.target} is now ${lines} line${lines === 1 ? '' : 's'}.`;
}

export const fileWrite: ToolDefinition = {
  schema: {
    name: 'file_write',
    description: [
      'Create a file, or replace an existing one with new contents.',
      '',
      'The user is shown a line-by-line diff of what this would change and must approve it',
      'before anything is written, so the whole file body goes in "content" - there is no',
      'append mode and no partial write.',
      '',
      'Prefer file_edit for a change to an existing file: replacing a whole file you have not',
      'read discards whatever else was in it. Read a file before overwriting it.',
      'Only paths inside the folders the user has shared can be written.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to create or replace.' },
        content: { type: 'string', description: 'The complete new contents of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },

  approval: async (input, context) => toPrompt(await planWrite(input, context)),

  async run(input, context) {
    return planAndApply(input, context, planWrite);
  },
};

export const fileEdit: ToolDefinition = {
  schema: {
    name: 'file_edit',
    description: [
      'Replace exact stretches of text in an existing file, leaving the rest untouched.',
      '',
      'Make every change you have planned for one file in a single call: pass them as "edits",',
      'applied in order, each against the result of the one before, and all-or-nothing - if any',
      'edit fails nothing is written and the error names the failing one. Use the top-level',
      'oldText/newText only for a lone change.',
      '',
      '"oldText" must match the file exactly, including indentation and line breaks, and must',
      'identify one place uniquely - include the surrounding lines if it does not. Read the file',
      'first; an edit against remembered or guessed text will be rejected rather than applied.',
      '',
      'The user approves a diff of the change before it is written. Only paths inside the',
      'folders the user has shared can be edited.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to edit.' },
        oldText: {
          type: 'string',
          description: 'Exact text to replace, copied from the file. Omit when using "edits".',
        },
        newText: {
          type: 'string',
          description: 'Text to put in its place. Empty string deletes it. Omit when using "edits".',
        },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique one.' },
        edits: {
          type: 'array',
          maxItems: MAX_BATCH_EDITS,
          description:
            "Several edits to this file, applied in order against each other's results, all or nothing. Use instead of oldText/newText.",
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to replace.' },
              newText: { type: 'string', description: 'Text to put in its place. Empty string deletes it.' },
              replaceAll: {
                type: 'boolean',
                description: 'Replace every occurrence instead of requiring a unique one.',
              },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },

  approval: async (input, context) => toPrompt(await planEdit(input, context)),

  async run(input, context) {
    return planAndApply(input, context, planEdit);
  },
};
