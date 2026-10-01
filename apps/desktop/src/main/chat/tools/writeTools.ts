import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatDiff } from '@shared/chat';
import { buildDiff, diffLines, splitLines, summarizeDiff } from './diff';
import { isWithin, PathAccessDenied, realpathNearest, resolveWithinRoots } from './paths';
import { recordRecentFile } from './recentFiles';
import { credentialPaths } from './sandbox';
import { requireString, type ApprovalPrompt, type ToolContext, type ToolDefinition } from './types';

/**
 * Ceiling on both the file being replaced and the content replacing it. A write the user
 * cannot meaningfully read in a diff is one they cannot meaningfully consent to, and holding
 * two copies of a huge file in memory to diff them is its own problem.
 */
export const MAX_WRITE_BYTES = 1_000_000;

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
export async function resolveWritablePath(requested: string, context: ToolContext): Promise<string> {
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

export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Identity of the file as it was when the diff was built. 'absent' is not the same as empty. */
export function fingerprint(exists: boolean, content: string): string {
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

export function remember(key: string, state: string): void {
  if (approvedState.size >= MAX_REMEMBERED) {
    const oldest = approvedState.keys().next().value;
    if (oldest !== undefined) approvedState.delete(oldest);
  }
  approvedState.set(key, state);
}

export function forget(key: string): void {
  approvedState.delete(key);
}

/**
 * What each write this module made replaced, keyed by the target and the fingerprint it left
 * behind. Lets a stale approval be traced back through this app's own writes: two approved
 * edits to one file in a single round both saw the original, and the second must still apply
 * on top of the first rather than be refused as if someone else had touched the file.
 */
const ownWrites = new Map<string, string>();
const MAX_OWN_WRITES = 200;

export function recordOwnWrite(target: string, before: string, after: string): void {
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
export function assertUnchanged(key: string, target: string, current: string): void {
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

export async function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
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

export interface TargetState {
  exists: boolean;
  content: string;
}

export async function readTarget(target: string, options: { allowBinary?: boolean } = {}): Promise<TargetState> {
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
  if (!options.allowBinary && content.includes('\u0000')) {
    throw new Error(`${target} looks like a binary file. Refusing to rewrite it as text.`);
  }
  return { exists: true, content };
}

// Tab, LF, CR and form feed are the only C0 controls real source text carries. Anything else is
// nearly always a garbled escape (a model emitting \u00b7 as NUL plus "b7"), not intent.
const isForbiddenControl = (code: number): boolean =>
  code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c;

export function assertNoControlCharacters(text: string, label: string): void {
  let index = 0;
  while (index < text.length && !isForbiddenControl(text.charCodeAt(index))) index += 1;
  if (index === text.length) return;
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  const code = text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  throw new Error(
    `${label} contains U+${code} at line ${line}, column ${column}, which looks like a garbled \\u escape. ` +
      'Write the character itself (e.g. the actual middle dot) instead of an escape. Nothing was written.'
  );
}

interface WritePlan {
  target: string;
  state: TargetState;
  after: string;
  diff: ChatDiff;
  key: string;
  /** Appended to the result so the model learns what was normalised or skipped on its behalf. */
  notes?: string[];
  /** Set when there is nothing to write; returned as the (non-error) result. */
  unchanged?: string;
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

  assertNoControlCharacters(after, '"content"');

  const target = await resolveWritablePath(requested, context);
  // A whole-file replacement discards the old bytes, so a file already corrupted with NULs can
  // be repaired this way; only an in-place edit has to refuse it.
  const state = await readTarget(target, { allowBinary: true });
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
          oldText: requireText(input, 'oldText'),
          newText: requireText(input, 'newText'),
          replaceAll: input.replaceAll === true,
        },
      ],
      batch: false,
    };
  }

  // Models leave empty or stale single-form fields next to `edits`; only real content in both
  // forms is a genuine conflict.
  const carriesText = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  if (carriesText(input.oldText) || carriesText(input.newText)) {
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
        oldText: requireText(record, 'oldText'),
        newText: requireText(record, 'newText'),
        replaceAll: record.replaceAll === true,
      };
    } catch (error) {
      throw new Error(`edits[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { edits, batch: true };
}

/**
 * How much file text an error may quote back. The message is read by a model, so a hint that
 * pastes a whole region costs more context than the re-read it saves.
 */
const MAX_HINT_LINES = 4;
const MAX_HINT_LINE_CHARS = 200;

/** Quoted verbatim and unnumbered: the model is meant to copy this straight back into "oldText". */
function quoteForHint(lines: string[]): string {
  const shown = lines
    .slice(0, MAX_HINT_LINES)
    .map(line => (line.length > MAX_HINT_LINE_CHARS ? `${line.slice(0, MAX_HINT_LINE_CHARS)}...` : line));
  if (lines.length > MAX_HINT_LINES) shown.push('...');
  return shown.join('\n');
}

const squeezeSpacing = (text: string): string => text.replace(/[ \t]/g, '');

/** Index in `text` of the `nth` character that survives `squeezeSpacing`. */
function unsqueezeIndex(text: string, nth: number): number {
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === ' ' || char === '\t') continue;
    if (seen === nth) return index;
    seen += 1;
  }
  return text.length;
}

function describeLineEndingMiss(content: string, oldText: string): string | null {
  const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
  if (countOccurrences(toLf(content), toLf(oldText)) === 0) return null;

  return content.includes('\r\n')
    ? 'The text is there, but the file uses CRLF line endings and "oldText" uses bare LF. ' +
        'Copy the line breaks from the file, or replace one line at a time.'
    : 'The text is there, but "oldText" uses CRLF line endings and the file uses bare LF. ' +
        'Drop the carriage returns, or replace one line at a time.';
}

/**
 * Spaces and tabs are stripped from both sides rather than collapsed, so a hit proves the two
 * differ in nothing else - the message can name the cause outright instead of guessing at it.
 */
function describeSpacingMiss(content: string, oldText: string): string | null {
  const wanted = squeezeSpacing(oldText);
  if (wanted.length === 0) return null;
  const flattened = squeezeSpacing(content);
  const at = flattened.indexOf(wanted);
  if (at === -1) return null;

  let start = unsqueezeIndex(content, at);
  let end = unsqueezeIndex(content, at + wanted.length - 1) + 1;
  // A squeezed match lands on the first surviving character, which would trim the file's own
  // indentation out of the one hint whose whole job is to show it.
  const blank = (index: number): boolean => content[index] === ' ' || content[index] === '\t';
  if (/^[ \t]/.test(oldText)) while (start > 0 && blank(start - 1)) start -= 1;
  if (/[ \t]$/.test(oldText)) while (end < content.length && blank(end)) end += 1;
  const ambiguous =
    countOccurrences(flattened, wanted) > 1
      ? ' It matches in more than one place, so include surrounding lines as well.'
      : '';
  return (
    'The text is there, but its indentation or spacing differs. The file has:\n' +
    `${quoteForHint(splitLines(content.slice(start, end)))}\nUse that exactly.${ambiguous}`
  );
}

const REREAD = 'Read the file and copy the exact text to replace, including its indentation and line breaks.';

/**
 * A line of `oldText` that occurs exactly once places the edit without a second read of the
 * whole file; no line occurring at all is worth saying plainly, because then re-reading really
 * is the only move left.
 */
function describeLineMiss(content: string, oldText: string): string | null {
  const fileLines = splitLines(content);
  const trimmed = fileLines.map(line => line.trim());
  let anyPresent = false;

  for (const line of splitLines(oldText)) {
    const needle = line.trim();
    if (needle.length === 0) continue;
    const at = trimmed.indexOf(needle);
    if (at === -1) continue;
    anyPresent = true;
    if (trimmed.indexOf(needle, at + 1) !== -1) continue;

    const from = Math.max(0, at - 1);
    return (
      `Its line "${needle.length > MAX_HINT_LINE_CHARS ? `${needle.slice(0, MAX_HINT_LINE_CHARS)}...` : needle}" ` +
      `is at line ${at + 1}, surrounded by:\n${quoteForHint(fileLines.slice(from, at + 2))}\n` +
      'Correct "oldText" against that.'
    );
  }

  return anyPresent
    ? null
    : `None of its lines appear in the file, so the file has changed or this text is not from it. ${REREAD}`;
}

/**
 * Why `oldText` missed, when the reason can be proved outright. Every check below is exact and
 * never a similarity score: a confident wrong hint sends the model chasing text that was never
 * there, which costs more than the honest "read it again" it would replace.
 */
function describeMiss(content: string, oldText: string): string {
  return (
    describeLineEndingMiss(content, oldText) ??
    describeSpacingMiss(content, oldText) ??
    describeLineMiss(content, oldText) ??
    REREAD
  );
}

interface EditPosition {
  index: number;
  total: number;
}

const MAX_LISTED_MATCHES = 8;
const MAX_PREVIEW_CHARS = 100;

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let at = content.indexOf('\n'); at !== -1 && at < index; at = content.indexOf('\n', at + 1)) line += 1;
  return line;
}

function previewLine(line: string): string {
  const text = line.trim();
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}...` : text;
}

/** "at lines 120, 188, 240" plus a preview of each, so one retry can pick a place and add context. */
function describeLocations(lines: number[], fileLines: string[]): string {
  const shown = lines.slice(0, MAX_LISTED_MATCHES);
  const more = lines.length > shown.length ? `, and ${lines.length - shown.length} more` : '';
  const previews = shown.map(line => `  ${line}: ${previewLine(fileLines[line - 1] ?? '')}`).join('\n');
  return `at lines ${shown.join(', ')}${more}:\n${previews}`;
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';
const isBlank = (line: string): boolean => line.trim() === '';

function stripCommonIndent(lines: string[]): string[] {
  const widths = lines.filter(line => !isBlank(line)).map(line => indentOf(line).length);
  const common = widths.length ? Math.min(...widths) : 0;
  return lines.map(line => line.slice(common).trimEnd());
}

/** Start line of every window of `file` that equals `wanted` under `normalise`. */
function findWindows(file: string[], wanted: string[], normalise: (lines: string[]) => string[]): number[] {
  const target = normalise(wanted);
  const starts: number[] = [];
  for (let at = 0; at + wanted.length <= file.length; at += 1) {
    const window = normalise(file.slice(at, at + wanted.length));
    if (window.every((line, offset) => line === target[offset])) starts.push(at);
  }
  return starts;
}

// Ordered strictest first: indentation-flexible keeps relative indentation, so it can single out
// one place where line-trimmed finds several. Nothing looser (anchors, similarity) on purpose.
const LOOSE_MATCHERS: Array<(lines: string[]) => string[]> = [
  lines => lines.map(line => line.trim()),
  stripCommonIndent,
];

/** Shifts `newText` by the same indentation delta the file has against `oldText`, when it is uniform. */
function reindent(newText: string, wanted: string[], actual: string[]): string {
  let add: string | null = null;
  let remove = '';
  for (let at = 0; at < wanted.length; at += 1) {
    if (isBlank(wanted[at])) continue;
    const was = indentOf(wanted[at]);
    const now = indentOf(actual[at]);
    let pairAdd: string;
    let pairRemove: string;
    if (now.startsWith(was)) {
      pairAdd = now.slice(was.length);
      pairRemove = '';
    } else if (was.startsWith(now)) {
      pairAdd = '';
      pairRemove = was.slice(now.length);
    } else {
      return newText;
    }
    if (add === null) {
      add = pairAdd;
      remove = pairRemove;
    } else if (add !== pairAdd || remove !== pairRemove) {
      return newText;
    }
  }
  if (!add && !remove) return newText;
  return newText
    .split('\n')
    .map(line => {
      if (isBlank(line)) return line;
      return remove ? (line.startsWith(remove) ? line.slice(remove.length) : line) : `${add}${line}`;
    })
    .join('\n');
}

type LooseResult =
  { kind: 'applied'; content: string } | { kind: 'ambiguous'; lines: number[]; fileLines: string[] } | { kind: 'none' };

/** Whole-line matching that ignores indentation and spacing; applies only when exactly one place matches. */
function applyLoose(content: string, oldText: string, newText: string): LooseResult {
  const fileLines = content.split('\n');
  const wanted = oldText.split('\n');
  const trailingNewline = wanted.length > 1 && wanted[wanted.length - 1] === '';
  if (trailingNewline) wanted.pop();
  if (wanted.every(isBlank)) return { kind: 'none' };

  let ambiguous: number[] = [];
  for (const normalise of LOOSE_MATCHERS) {
    const starts = findWindows(fileLines, wanted, normalise);
    if (starts.length === 0) continue;
    if (starts.length > 1) {
      if (ambiguous.length === 0) ambiguous = starts.map(start => start + 1);
      continue;
    }

    const first = starts[0];
    const last = first + wanted.length - 1;
    const actual = fileLines.slice(first, last + 1);
    const offsets: number[] = [];
    let running = 0;
    for (const line of fileLines) {
      offsets.push(running);
      running += line.length + 1;
    }
    const start = offsets[first];
    const end =
      trailingNewline && last < fileLines.length - 1
        ? offsets[last + 1]
        : offsets[last] + fileLines[last].replace(/\r$/, '').length;
    let replacement = reindent(newText, wanted, actual);
    // Line endings follow the file, whichever the model typed.
    replacement = replacement.replace(/\r?\n/g, actual.some(line => line.endsWith('\r')) ? '\r\n' : '\n');
    return { kind: 'applied', content: content.slice(0, start) + replacement + content.slice(end) };
  }

  return ambiguous.length > 0 ? { kind: 'ambiguous', lines: ambiguous, fileLines } : { kind: 'none' };
}

type PrefixFormat = 'read' | 'grep';

// The line formats our own tools emit: file_read `N<TAB>line`, grep_search `  N: line` for a
// match and `  N- line` for context, with `  --` between separate blocks.
const PREFIX_PATTERNS: Record<PrefixFormat, RegExp> = {
  read: /^\s*(\d+)\t(.*)$/,
  grep: /^\s*(\d+)[:-](?: (.*))?$/,
};
const GREP_SEPARATOR = /^\s*--\s*$/;

type StrippedPrefixes = { kind: 'block'; format: PrefixFormat; text: string } | { kind: 'regions' };

/**
 * `oldText` pasted from file_read or grep_search output, line-number prefixes and all. Only
 * consistent, consecutively numbered prefixes qualify: anything looser would rewrite text that
 * merely happens to start with digits. Chunks split by grep's `--` are never stitched together,
 * since the lines between them are unknown.
 */
function stripLinePrefixes(oldText: string): StrippedPrefixes | null {
  const lines = oldText.split('\n');
  for (const format of ['read', 'grep'] as const) {
    const pattern = PREFIX_PATTERNS[format];
    const chunks: string[][] = [[]];
    let prefixed = 0;
    let expected: number | null = null;
    let ok = true;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (format === 'grep' && GREP_SEPARATOR.test(line)) {
        chunks.push([]);
        expected = null;
        continue;
      }
      if (isBlank(line)) {
        chunks[chunks.length - 1].push('');
        if (expected !== null) expected += 1;
        continue;
      }
      const match = pattern.exec(line);
      if (!match || (expected !== null && Number(match[1]) !== expected)) {
        ok = false;
        break;
      }
      expected = Number(match[1]) + 1;
      prefixed += 1;
      chunks[chunks.length - 1].push(match[2] ?? '');
    }
    if (!ok || prefixed === 0) continue;

    const filled = chunks.filter(chunk => chunk.some(line => line !== ''));
    if (filled.length > 1) return { kind: 'regions' };
    return { kind: 'block', format, text: (filled[0] ?? []).join('\n') + (oldText.endsWith('\n') ? '\n' : '') };
  }
  return null;
}

/** `newText` carrying the same prefix format, with nothing but numbered lines in it. */
function stripSameFormat(newText: string, format: PrefixFormat): string | null {
  const pattern = PREFIX_PATTERNS[format];
  const out: string[] = [];
  let prefixed = 0;
  for (const raw of newText.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (isBlank(line)) {
      out.push('');
      continue;
    }
    const match = pattern.exec(line);
    if (!match) return null;
    prefixed += 1;
    out.push(match[2] ?? '');
  }
  return prefixed > 0 ? out.join('\n') : null;
}

interface EditOutcome {
  content: string;
  status: 'applied' | 'loose' | 'noop';
  strippedPrefixes?: boolean;
}

/** Applies one edit to `content`, or throws. `position` names the edit in a batch, null for a lone edit. */
function applyEdit(
  content: string,
  edit: EditSpec,
  target: string,
  position: EditPosition | null,
  allowPrefixStrip = true
): EditOutcome {
  const { oldText, newText, replaceAll } = edit;
  const label = position
    ? `edits[${position.index}] (edit ${position.index + 1} of ${position.total}, nothing was written)`
    : '';
  const subject = label ? `${label}: "oldText"` : '"oldText"';
  // `content` is the file itself until an earlier edit has actually run against it. Blaming
  // edits that never happened points the model at reconstructing its own chain, when what it
  // needs is the file.
  const where = position && position.index > 0 ? `${target} as it stands after the earlier edits` : target;

  if (oldText === newText) return { content, status: 'noop' };

  const occurrences = countOccurrences(content, oldText);
  if (occurrences === 0) {
    const loose = applyLoose(content, oldText, newText);
    if (loose.kind === 'applied') return { content: loose.content, status: 'loose' };

    const stripped = allowPrefixStrip ? stripLinePrefixes(oldText) : null;
    if (stripped?.kind === 'regions') {
      throw new Error(
        `${subject} was copied from grep output: it has line-number prefixes and separate regions ` +
          '(the "--" lines), and those regions are not adjacent in the file. Copy the text from file_read ' +
          'output instead, without the line-number prefixes, and edit one region at a time.'
      );
    }
    if (stripped?.kind === 'block') {
      const stripNew = stripSameFormat(newText, stripped.format);
      try {
        const inner = applyEdit(
          content,
          { oldText: stripped.text, newText: stripNew ?? newText, replaceAll },
          target,
          position,
          false
        );
        return { ...inner, strippedPrefixes: true };
      } catch (error) {
        throw new Error(
          `${subject} carried line-number prefixes, which were removed before matching. ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }

    if (loose.kind === 'ambiguous') {
      throw new Error(
        `${subject} does not match ${where} exactly, and ignoring indentation and spacing it matches ` +
          `${loose.lines.length} places, so the edit is ambiguous, ${describeLocations(loose.lines, loose.fileLines)}\n` +
          'Include enough surrounding lines, copied exactly, to make it unique.'
      );
    }
    throw new Error(`${subject} does not appear in ${where}. ${describeMiss(content, oldText)}`);
  }
  if (occurrences > 1 && !replaceAll) {
    const lines: number[] = [];
    for (let at = content.indexOf(oldText); at !== -1; at = content.indexOf(oldText, at + oldText.length)) {
      lines.push(lineNumberAt(content, at));
    }
    throw new Error(
      `${subject} appears ${occurrences} times in ${where}, so the edit is ambiguous, ` +
        `${describeLocations(lines, content.split('\n'))}\n` +
        'Include enough surrounding lines to make it unique, or pass replaceAll: true to change every one.'
    );
  }

  // A function replacement, because `$&` and friends in a plain replacement string would be
  // expanded - silently corrupting any edit whose new text contains a dollar sign.
  const next = replaceAll ? content.replaceAll(oldText, () => newText) : content.replace(oldText, () => newText);
  return { content: next, status: 'applied' };
}

async function planEdit(input: Record<string, unknown>, context: ToolContext): Promise<WritePlan> {
  const requested = requireString(input, 'path');
  const { edits, batch } = readEdits(input);
  edits.forEach((edit, index) =>
    assertNoControlCharacters(edit.newText, batch ? `edits[${index}].newText` : 'newText')
  );

  const target = await resolveWritablePath(requested, context);
  const state = await readTarget(target);

  const emptyAt = edits.findIndex(edit => edit.oldText === '');
  if (emptyAt !== -1) {
    if (edits.length > 1) {
      throw new Error(
        'An empty "oldText" creates a new file and is only allowed as the single edit in a call. ' +
          'Put the whole file in one edit, or use file_write.'
      );
    }
    if (state.exists && state.content.length > 0) {
      throw new Error(
        `"oldText" is empty but ${target} already has content. An empty "oldText" only creates a new file; ` +
          'use file_write to replace a whole file, or pass the text to replace.'
      );
    }
    const after = edits[0].newText;
    if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`"newText" is larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
    }
    return {
      target,
      state,
      after,
      diff: buildDiff(target, state.exists ? 'overwrite' : 'create', state.content, after),
      key: editsKeyFor(target, edits),
    };
  }

  if (!state.exists) {
    throw new Error(`${target} does not exist. Use file_write to create it, or file_edit with an empty "oldText".`);
  }

  // All in memory and in order, each against the previous result: nothing is written unless
  // every edit applies. A failing edit is skipped rather than thrown on the spot so one error
  // can name every failure and confirm the rest, instead of costing a retry per bad edit.
  let after = state.content;
  const failures: string[] = [];
  const failed = new Set<number>();
  const notes: string[] = [];
  let changed = 0;
  edits.forEach((edit, index) => {
    const name = batch ? `edits[${index}]` : 'The edit';
    try {
      const outcome = applyEdit(after, edit, target, batch ? { index, total: edits.length } : null);
      after = outcome.content;
      if (outcome.status === 'noop') {
        notes.push(`${name} was skipped: "newText" is identical to "oldText", so it would change nothing.`);
      } else {
        changed += 1;
        if (outcome.strippedPrefixes) {
          notes.push(
            `${name} was applied after removing line-number prefixes from "oldText"; copy text without them next time.`
          );
        }
        if (outcome.status === 'loose') {
          notes.push(
            `${name} was applied with whitespace-normalized matching: "oldText" differed from the file in indentation or spacing.`
          );
        }
      }
    } catch (error) {
      failed.add(index);
      failures.push(error instanceof Error ? error.message : String(error));
    }
  });

  if (failures.length > 0) {
    const fine = edits.map((_, index) => index).filter(index => !failed.has(index));
    const tail =
      batch && fine.length > 0
        ? `\nThe other edits (${fine.map(index => `edits[${index}]`).join(', ')}) were fine. Fix only the failing ` +
          `${failed.size === 1 ? 'one' : 'ones'} and resend the whole batch; nothing was written.`
        : '';
    throw new Error(`${failures.join('\n')}${tail}`);
  }

  const key = editsKeyFor(target, edits);
  if (changed === 0) {
    return {
      target,
      state,
      after,
      diff: buildDiff(target, 'edit', state.content, after),
      key,
      unchanged: `No change made: every edit's "newText" equals its "oldText", so ${target} is untouched.`,
    };
  }
  if (after === state.content) {
    throw new Error('The edits cancel each other out, so this call would change nothing.');
  }
  if (Buffer.byteLength(after, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`The result would be larger than the ${MAX_WRITE_BYTES} byte limit for a single write.`);
  }

  return { target, state, after, diff: buildDiff(target, 'edit', state.content, after), key, notes };
}

function editsKeyFor(target: string, edits: EditSpec[]): string {
  const editsKey = edits.map(e => `${sha(e.oldText)}\x00${sha(e.newText)}\x00${e.replaceAll}`).join('\x01');
  return `file_edit\x00${target}\x00${editsKey}`;
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

const SNIPPET_CONTEXT_LINES = 4;
const MAX_SNIPPET_LINES = 60;
const MAX_SNIPPET_TOTAL_LINES = 300;

/**
 * The edited regions as the file now reads, in file_read's `N<TAB>line` format. Lets the model
 * chain the next edit from this result instead of reading the whole file again.
 */
export function editSnippets(before: string, after: string): string {
  const fileLines = splitLines(after);
  if (fileLines.length === 0) return '';

  const changed: Array<[number, number]> = [];
  let cursor = 1;
  for (const op of diffLines(splitLines(before), fileLines).ops) {
    if (op.kind === 'context') {
      cursor = (op.newLine ?? cursor) + 1;
      continue;
    }
    const at = op.kind === 'add' ? (op.newLine ?? cursor) : cursor;
    const last = changed[changed.length - 1];
    if (op.kind === 'add') cursor = at + 1;
    if (last && at <= last[1] + 1) last[1] = Math.max(last[1], op.kind === 'add' ? at : at - 1);
    else changed.push([at, op.kind === 'add' ? at : at - 1]);
  }

  const ranges: Array<[number, number]> = [];
  for (const [from, to] of changed) {
    const start = Math.max(1, from - SNIPPET_CONTEXT_LINES);
    const end = Math.min(fileLines.length, Math.max(to, from) + SNIPPET_CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const sections: string[] = [];
  let budget = MAX_SNIPPET_TOTAL_LINES;
  for (const [start, end] of ranges) {
    if (budget <= 0) {
      sections.push('[More edited regions not shown.]');
      break;
    }
    const shownEnd = Math.min(end, start + Math.min(MAX_SNIPPET_LINES, budget) - 1);
    const width = String(shownEnd).length;
    const rows = fileLines
      .slice(start - 1, shownEnd)
      .map((line, index) => `${String(start + index).padStart(width)}\t${line.replace(/\r$/, '')}`);
    const cut = shownEnd < end ? `\n[Lines ${shownEnd + 1}-${end} of this region not shown.]` : '';
    sections.push(`[Edited region, lines ${start}-${shownEnd} as they now read:]\n${rows.join('\n')}${cut}`);
    budget -= shownEnd - start + 1;
  }
  return sections.length > 0 ? `\n${sections.join('\n\n')}` : '';
}

/** Applies an already-planned change, after one last check that the plan still holds. */
async function applyPlan(plan: WritePlan, context: ToolContext): Promise<string> {
  if (plan.unchanged) {
    approvedState.delete(plan.key);
    return plan.unchanged;
  }
  assertUnchanged(plan.key, plan.target, fingerprint(plan.state.exists, plan.state.content));
  if (context.signal.aborted) throw new Error('The turn was stopped before this change was written.');

  // Recursive, but the target is already proven to sit inside a granted root, so every parent
  // this creates is inside it too.
  await mkdir(dirname(plan.target), { recursive: true });
  await writeFile(plan.target, plan.after, 'utf8');
  recordOwnWrite(plan.target, fingerprint(plan.state.exists, plan.state.content), fingerprint(true, plan.after));
  approvedState.delete(plan.key);
  recordRecentFile(context, plan.target);

  // AFTER the write, deliberately: everything above can throw - a revoked root, a stale
  // approval, a stopped turn - and a transcript row showing a diff for a write that never
  // happened would be worse than one showing none. The diff is the plan rather than a re-read
  // of the file because the plan is what was written, under this path's lock, having just
  // checked the file still matched it; re-reading now would pick up whoever wrote next.
  context.report?.diff(plan.diff);

  const lines = splitLines(plan.after).length;
  const notes = plan.notes?.length ? `\n${plan.notes.join('\n')}` : '';
  const snippets = plan.diff.operation === 'edit' ? editSnippets(plan.state.content, plan.after) : '';
  return `${summarizeDiff(plan.diff)}\nWritten. ${plan.target} is now ${lines} line${lines === 1 ? '' : 's'}.${notes}${snippets}`;
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
      'An empty "oldText" as the only edit creates a file that does not exist yet (use file_write',
      'to replace an existing file).',
      '',
      'Make every change you have planned for one file in a single call: pass them as "edits",',
      'applied in order, each against the result of the one before, and all-or-nothing - if any',
      'edit fails nothing is written and the error names the failing ones and confirms the rest.',
      'Use the top-level oldText/newText only for a lone change. An edit whose newText equals its',
      'oldText is skipped.',
      '',
      '"oldText" should be copied from the file and must identify one place uniquely - include the',
      'surrounding lines if it does not. Indentation and spacing differences are tolerated when',
      'exactly one place matches. Read the file first; guessed text is rejected.',
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
