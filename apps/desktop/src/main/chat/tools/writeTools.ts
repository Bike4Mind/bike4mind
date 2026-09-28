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

/** Reject a stale approval. Absent state means no gate ran, which the gate itself decides. */
function assertUnchanged(key: string, target: string, current: string): void {
  const approved = approvedState.get(key);
  if (approved !== undefined && approved !== current) {
    throw new Error(
      `${target} changed on disk after the user approved this change, so the change they saw no ` +
        'longer applies. Read the file again and propose the edit against its current contents.'
    );
  }
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

async function planEdit(input: Record<string, unknown>, context: ToolContext): Promise<WritePlan> {
  const requested = requireString(input, 'path');
  const oldText = requireString(input, 'oldText');
  const newText = requireText(input, 'newText');
  const replaceAll = input.replaceAll === true;

  const target = await resolveWritablePath(requested, context);
  const state = await readTarget(target);
  if (!state.exists) {
    throw new Error(`${target} does not exist. Use file_write to create it.`);
  }

  const occurrences = countOccurrences(state.content, oldText);
  if (occurrences === 0) {
    throw new Error(
      `"oldText" does not appear in ${target}. Read the file and copy the exact text to replace, ` +
        'including its indentation and line breaks.'
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `"oldText" appears ${occurrences} times in ${target}, so the edit is ambiguous. Include ` +
        'enough surrounding lines to make it unique, or pass replaceAll: true to change every one.'
    );
  }

  // A function replacement, because `$&` and friends in a plain replacement string would be
  // expanded - silently corrupting any edit whose new text contains a dollar sign.
  const after = replaceAll
    ? state.content.replaceAll(oldText, () => newText)
    : state.content.replace(oldText, () => newText);
  if (after === state.content) {
    throw new Error('"newText" is identical to "oldText", so this edit would change nothing.');
  }
  if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`The result would be larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
  }

  const diff = buildDiff(target, 'edit', state.content, after);
  return {
    target,
    state,
    after,
    diff,
    key: `file_edit\x00${target}\x00${sha(oldText)}\x00${sha(newText)}\x00${replaceAll}`,
  };
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
  approvedState.delete(plan.key);

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
    return applyPlan(await planWrite(input, context), context);
  },
};

export const fileEdit: ToolDefinition = {
  schema: {
    name: 'file_edit',
    description: [
      'Replace an exact stretch of text in an existing file, leaving the rest untouched.',
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
        oldText: { type: 'string', description: 'Exact text to replace, copied from the file.' },
        newText: { type: 'string', description: 'Text to put in its place. Empty string deletes it.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique one.' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },

  approval: async (input, context) => toPrompt(await planEdit(input, context)),

  async run(input, context) {
    return applyPlan(await planEdit(input, context), context);
  },
};
