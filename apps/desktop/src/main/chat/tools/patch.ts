// Patch format and matching adapted from opencode (MIT).

/**
 * The Codex `apply_patch` envelope: parsing it, and locating its hunks in a file.
 *
 * Pure text in, text out - no filesystem, no approval. applyPatchTool.ts owns everything that
 * touches disk, so the whole patch can be validated before anything is written.
 */

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const END_OF_FILE = '*** End of File';
const ADD = '*** Add File:';
const DELETE = '*** Delete File:';
const UPDATE = '*** Update File:';
const MOVE = '*** Move to:';

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchParseError';
  }
}

export interface PatchChunk {
  /** `@@` lines ahead of the change, each searched for in turn to place it. */
  anchors: string[];
  oldLines: string[];
  newLines: string[];
  /** Every line in order, so a fuzzy match can keep the file's own text for unchanged lines. */
  body: { mark: ' ' | '-' | '+'; text: string }[];
  /** The `+` lines alone: the only text the model wrote, and so the only text worth screening. */
  addedLines: string[];
  endOfFile: boolean;
}

export type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] };

/** Models paste the patch the way a shell would take it: `cat <<'EOF' ... EOF`. */
function stripHeredoc(text: string): string {
  const match = /^(?:(?:cat|apply_patch)\s+)?<<-?['"]?(\w+)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/.exec(text);
  return match ? match[2] : text;
}

function headerPath(line: string, prefix: string): string {
  return line.slice(prefix.length).trim();
}

const isHeader = (line: string): boolean => line.startsWith('***');

export function parsePatch(patchText: string): PatchOp[] {
  const lines = stripHeredoc(patchText.replace(/\r\n/g, '\n').trim()).split('\n');
  const begin = lines.findIndex(line => line.trim() === BEGIN);
  if (begin === -1) throw new PatchParseError(`The patch must start with a "${BEGIN}" line.`);
  const end = lines.findIndex((line, index) => index > begin && line.trim() === END);
  if (end === -1) throw new PatchParseError(`The patch must finish with a "${END}" line.`);

  const ops: PatchOp[] = [];
  let at = begin + 1;
  while (at < end) {
    const line = lines[at];
    if (line.trim() === '') {
      at += 1;
      continue;
    }

    if (line.startsWith(ADD)) {
      const path = requirePath(line, ADD, at);
      const added: string[] = [];
      at += 1;
      while (at < end && !isHeader(lines[at])) {
        if (!lines[at].startsWith('+')) {
          throw new PatchParseError(
            `Line ${at - begin}: every line of an Add File section must start with "+", got: ${show(lines[at])}`
          );
        }
        added.push(lines[at].slice(1));
        at += 1;
      }
      ops.push({ kind: 'add', path, lines: added });
    } else if (line.startsWith(DELETE)) {
      ops.push({ kind: 'delete', path: requirePath(line, DELETE, at) });
      at += 1;
    } else if (line.startsWith(UPDATE)) {
      const path = requirePath(line, UPDATE, at);
      at += 1;
      let moveTo: string | undefined;
      if (at < end && lines[at].startsWith(MOVE)) {
        moveTo = requirePath(lines[at], MOVE, at);
        at += 1;
      }
      const parsed = parseChunks(lines, at, end, begin);
      if (parsed.chunks.length === 0 && !moveTo) {
        throw new PatchParseError(`Line ${at - begin}: the Update File section for ${path} has no hunks.`);
      }
      ops.push({ kind: 'update', path, ...(moveTo ? { moveTo } : {}), chunks: parsed.chunks });
      at = parsed.next;
    } else {
      throw new PatchParseError(
        `Line ${at - begin}: expected "${ADD} <path>", "${DELETE} <path>" or "${UPDATE} <path>", got: ${show(line)}`
      );
    }
  }
  return ops;

  function requirePath(headerLine: string, prefix: string, index: number): string {
    const path = headerPath(headerLine, prefix);
    if (!path) throw new PatchParseError(`Line ${index - begin}: "${prefix}" needs a path.`);
    return path;
  }
}

const show = (line: string): string => JSON.stringify(line.length > 80 ? `${line.slice(0, 80)}...` : line);

function parseChunks(
  lines: readonly string[],
  start: number,
  end: number,
  begin: number
): { chunks: PatchChunk[]; next: number } {
  const chunks: PatchChunk[] = [];
  let at = start;

  while (at < end && !isHeader(lines[at])) {
    const chunk: PatchChunk = { anchors: [], oldLines: [], newLines: [], body: [], addedLines: [], endOfFile: false };
    // A hunk may carry several `@@` lines (a class, then a method inside it); only the first
    // hunk of a file may have none at all.
    while (at < end && lines[at].startsWith('@@')) {
      const anchor = lines[at].slice(2).trim();
      if (anchor) chunk.anchors.push(anchor);
      at += 1;
    }

    let bare = 0;
    while (at < end && !lines[at].startsWith('@@')) {
      const line = lines[at];
      if (line.trim() === END_OF_FILE) {
        chunk.endOfFile = true;
        at += 1;
        break;
      }
      if (isHeader(line)) break;

      bare = line === '' ? bare + 1 : 0;
      if (line.startsWith('+')) {
        chunk.newLines.push(line.slice(1));
        chunk.body.push({ mark: '+', text: line.slice(1) });
        chunk.addedLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        chunk.oldLines.push(line.slice(1));
        chunk.body.push({ mark: '-', text: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        // A bare empty line is how models write a blank context line.
        chunk.oldLines.push(line.slice(1));
        chunk.newLines.push(line.slice(1));
        chunk.body.push({ mark: ' ', text: line.slice(1) });
      } else {
        throw new PatchParseError(
          `Line ${at - begin}: a hunk line must start with " " (context), "-" or "+", got: ${show(line)}`
        );
      }
      at += 1;
    }

    // Blank lines that merely separate this hunk from the next section are not context.
    if (!chunk.endOfFile && bare > 0) {
      chunk.oldLines.length -= bare;
      chunk.newLines.length -= bare;
      chunk.body.length -= bare;
    }
    if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      throw new PatchParseError(`Line ${at - begin}: a hunk has no lines in it.`);
    }
    chunks.push(chunk);
  }
  return { chunks, next: at };
}

export type MatchLevel = 'exact' | 'trimEnd' | 'trim' | 'unicode';

const LEVELS: readonly MatchLevel[] = ['exact', 'trimEnd', 'trim', 'unicode'];

// Typographic punctuation a model normalises to ASCII when it copies a line.
function normalizeUnicode(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

const COMPARE: Record<MatchLevel, (a: string, b: string) => boolean> = {
  exact: (a, b) => a === b,
  trimEnd: (a, b) => a.trimEnd() === b.trimEnd(),
  trim: (a, b) => a.trim() === b.trim(),
  unicode: (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
};

function matchesAt(
  lines: readonly string[],
  pattern: readonly string[],
  at: number,
  same: (a: string, b: string) => boolean
): boolean {
  return pattern.every((line, offset) => same(lines[at + offset], line));
}

/**
 * The first place `pattern` occurs at or after `from`, trying the strictest comparison first.
 *
 * Searching forward from the previous hunk is what resolves a repeated line: a second `});`
 * means the one after the first hunk, not the first one in the file. An end-of-file hunk is
 * tried against the last lines before anything else.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  endOfFile = false
): { index: number; level: MatchLevel } | null {
  if (pattern.length === 0) return null;
  for (const level of LEVELS) {
    const same = COMPARE[level];
    if (endOfFile) {
      const last = lines.length - pattern.length;
      if (last >= from && matchesAt(lines, pattern, last, same)) return { index: last, level };
    }
    for (let at = from; at <= lines.length - pattern.length; at += 1) {
      if (matchesAt(lines, pattern, at, same)) return { index: at, level };
    }
  }
  return null;
}

export interface ChunkFailure {
  /** 1-based, in patch order. */
  hunk: number;
  message: string;
}

export interface AppliedChunks {
  lines: string[];
  failures: ChunkFailure[];
  /** The loosest comparison any hunk needed; 'exact' when none had to bend. */
  loosest: MatchLevel;
}

const MAX_QUOTED_LINES = 4;
const MAX_QUOTED_CHARS = 200;

function quote(lines: readonly string[]): string {
  const shown = lines
    .slice(0, MAX_QUOTED_LINES)
    .map(line => (line.length > MAX_QUOTED_CHARS ? `${line.slice(0, MAX_QUOTED_CHARS)}...` : line));
  if (lines.length > MAX_QUOTED_LINES) shown.push('...');
  return shown.join('\n');
}

const fold = (line: string): string => normalizeUnicode(line.trim());

function lineNumbers(lines: readonly string[], needle: string): number[] {
  const wanted = fold(needle);
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (fold(line) === wanted) found.push(index);
  });
  return found;
}

function excerpt(lines: readonly string[], from: number, count: number): string {
  const to = Math.min(lines.length, from + count);
  return lines
    .slice(from, to)
    .map(
      (line, offset) =>
        `${from + offset + 1}\t${line.length > MAX_QUOTED_CHARS ? `${line.slice(0, MAX_QUOTED_CHARS)}...` : line}`
    )
    .join('\n');
}

/** A file the session already knows, offered as the likely home of a hunk that missed. */
export interface OtherFile {
  display: string;
  lines: readonly string[];
}

// Statements so common that one matching says nothing about which file a hunk belongs to.
const GENERIC_LINE =
  /^(?:use\w+\(\(\) => \{|return(?: \(|;)?|\} else(?: if \(.*\))? \{|\} catch(?: \(\w+\))? \{|\} finally \{|try \{|else \{|break;|continue;|export default \w+;?)$/;

function isDistinctive(line: string): boolean {
  const text = line.trim();
  return text.length >= 12 && /[A-Za-z0-9]/.test(text) && !GENERIC_LINE.test(text);
}

/** The one other file the hunk's own lines point to, or none when it is unclear or absent. */
function findHome(
  expected: readonly string[],
  others: readonly OtherFile[],
  wholeHunkOnly = false
): string | undefined {
  const distinctive = expected.filter(isDistinctive);
  if (distinctive.length === 0) return undefined;
  const homes = others.filter(
    other =>
      seekSequence(other.lines, expected, 0) !== null ||
      (!wholeHunkOnly && distinctive.every(line => lineNumbers(other.lines, line).length > 0))
  );
  return homes.length === 1 ? homes[0].display : undefined;
}

/** Where the lines a hunk expected sit nearest to, so one retry can correct the hunk. */
function describeMiss(
  lines: readonly string[],
  expected: readonly string[],
  from: number,
  others: readonly OtherFile[] = []
): string {
  const searched = from > 0 ? ` at or after line ${from + 1}` : '';
  const header = `could not find these lines${searched}:\n${quote(expected)}`;

  for (const [offset, line] of expected.entries()) {
    if (line.trim() === '') continue;
    const hits = lineNumbers(lines, line);
    if (hits.length === 0) continue;

    const ahead = hits.find(index => index >= from);
    if (ahead !== undefined) {
      const first = offset === 0;
      const home = findHome(expected, others, true);
      const homeHint = home ? `\nThese lines are in ${home}; did you mean to patch that file?` : '';
      return (
        `${header}\nThe nearest match is ${first ? 'its first line' : `its line ${offset + 1}`} at line ${ahead + 1}, ` +
        `but the lines around it differ. The file has:\n${excerpt(lines, Math.max(0, ahead - offset), Math.min(expected.length, MAX_QUOTED_LINES))}${homeHint}`
      );
    }
  }

  const earlier = earlierEvidence(lines, expected, from);
  if (earlier) {
    return (
      `${header}\nIts ${earlier.offset === 0 ? 'first line' : `line ${earlier.offset + 1}`} appears only at line ${earlier.line + 1}, before ` +
      `where the previous hunk ended (line ${from}). Hunks are matched in file order, so put this one ` +
      'earlier in the patch, or include enough context to reach it.'
    );
  }

  const home = findHome(expected, others);
  if (home) return `${header}\nThese lines are in ${home}; did you mean to patch that file?`;
  return `${header}\nNone of those lines appear in the file; read it again before patching.`;
}

/**
 * Proof that a hunk sits before the previous one: the whole hunk matches there, or a distinctive
 * line occurs once in the file and only there. A lone `useEffect(() => {` proves nothing.
 */
function earlierEvidence(
  lines: readonly string[],
  expected: readonly string[],
  from: number
): { offset: number; line: number } | undefined {
  if (!expected.some(isDistinctive)) return undefined;
  const whole = seekSequence(lines, expected, 0);
  if (whole && whole.index < from) return { offset: 0, line: whole.index };

  for (const [offset, line] of expected.entries()) {
    if (!isDistinctive(line)) continue;
    const hits = lineNumbers(lines, line);
    if (hits.length === 1 && hits[0] < from) return { offset, line: hits[0] };
  }
  return undefined;
}

/**
 * What goes where the hunk matched. Unchanged lines keep the file's own text, so a hunk that
 * only matched after ignoring indentation does not re-indent the context around the change.
 */
function replacementLines(chunk: PatchChunk, fileLines: readonly string[], start: number, matched: number): string[] {
  const out: string[] = [];
  let seen = 0;
  for (const { mark, text } of chunk.body) {
    if (mark === '+') out.push(text);
    else {
      if (mark === ' ' && seen < matched) out.push(fileLines[start + seen]);
      seen += 1;
    }
  }
  return out;
}

type Replacement = { start: number; length: number; lines: string[] };

/**
 * Locate every hunk against `fileLines` and apply them, reporting every hunk that misses
 * instead of stopping at the first, so one error can name all of them.
 *
 * `lines` is meaningful only when `failures` is empty.
 */
export function applyChunks(
  fileLines: readonly string[],
  chunks: readonly PatchChunk[],
  others: readonly OtherFile[] = []
): AppliedChunks {
  const replacements: Replacement[] = [];
  const failures: ChunkFailure[] = [];
  let loosest = 0;
  let cursor = 0;

  const note = (level: MatchLevel): void => {
    loosest = Math.max(loosest, LEVELS.indexOf(level));
  };

  chunks.forEach((chunk, index) => {
    const hunk = index + 1;
    const label = `hunk ${hunk} of ${chunks.length}`;
    let from = cursor;

    for (const anchor of chunk.anchors) {
      const found = seekSequence(fileLines, [anchor], from);
      if (!found) {
        failures.push({ hunk, message: `${label}, "@@" context: ${describeMiss(fileLines, [anchor], from)}` });
        return;
      }
      note(found.level);
      from = found.index + 1;
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({ start: fileLines.length, length: 0, lines: chunk.newLines });
      return;
    }

    let pattern = chunk.oldLines;
    let found = seekSequence(fileLines, pattern, from, chunk.endOfFile);
    // A trailing blank line is the usual artefact of how the hunk was cut off.
    if (!found && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      found = seekSequence(fileLines, pattern, from, chunk.endOfFile);
    }

    if (!found) {
      failures.push({ hunk, message: `${label}: ${describeMiss(fileLines, chunk.oldLines, from, others)}` });
      return;
    }
    note(found.level);
    replacements.push({
      start: found.index,
      length: pattern.length,
      lines: replacementLines(chunk, fileLines, found.index, pattern.length),
    });
    cursor = found.index + pattern.length;
  });

  const lines = [...fileLines];
  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  for (let at = ordered.length - 1; at >= 0; at -= 1) {
    const { start, length, lines: next } = ordered[at];
    lines.splice(start, length, ...next);
  }
  return { lines, failures, loosest: LEVELS[loosest] };
}
