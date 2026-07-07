/**
 * Validated fuzzy fallback for `edit_local_file` string matching.
 *
 * This module is pure: no I/O, no `any`. It is invoked ONLY after an exact
 * `content.includes(old_string)` has already failed. The goal is to tolerate the
 * small ways a model's remembered `old_string` drifts from the file on disk
 * (leading indentation, a collapsed/added blank line, whitespace-run width, or
 * one level of `\n` / `\t` / `\"` escaping) without ever editing the wrong span.
 *
 * Safety properties (non-negotiable):
 *  - A fuzzy candidate is accepted only if the resolved span *literally occurs*
 *    in the file. `matchedText` is always sliced verbatim from `content`, so the
 *    replacement itself is exact.
 *  - Two genuinely distinct candidate spans => throw {@link AmbiguousMatchError};
 *    we never guess between locations.
 *  - A matched span disproportionately larger than `old_string` =>
 *    throw {@link DisproportionateMatchError} (stops anchor matching from
 *    bridging huge regions).
 *  - `new_string` is re-shaped to the matched span (uniform indentation delta +
 *    the file's line endings) so a tolerant match does not corrupt indentation
 *    or mix CRLF/LF.
 */

export class AmbiguousMatchError extends Error {
  constructor(count: number) {
    super(
      `Fuzzy match for old_string was ambiguous: it matched ${count} distinct locations. ` +
        `Provide a more specific old_string (include surrounding context) so it matches exactly one location.`
    );
    this.name = 'AmbiguousMatchError';
  }
}

export class DisproportionateMatchError extends Error {
  constructor() {
    super(
      `Fuzzy match resolved to a span much larger than old_string, which is unsafe. ` +
        `Please re-read the file and provide an exact old_string.`
    );
    this.name = 'DisproportionateMatchError';
  }
}

/** The matchers in the fuzzy cascade, in the order they are attempted. */
export type FuzzyStrategy =
  | 'escape-normalized'
  | 'line-trimmed'
  | 'whitespace-normalized'
  | 'blank-line-boundary'
  | 'block-anchor';

export interface FuzzyMatchResult {
  /** The exact substring of `content` that will be replaced (present verbatim). */
  matchedText: string;
  /** The replacement text, re-shaped to the matched span (indent delta + file EOL). */
  replacement: string;
  /** Character offset in `content` where {@link matchedText} begins. */
  startIndex: number;
  /** The matcher that produced this result (for logging / telemetry). */
  strategy: FuzzyStrategy;
}

/** A span whose char length exceeds this AND `old_string.length * ratio` is refused. */
const DISPROPORTION_MIN_LEN = 200;
const DISPROPORTION_RATIO = 3;

/** Anchor matching only applies to blocks of at least this many lines. */
const ANCHOR_MIN_LINES = 3;
/** Fraction of an anchor block's interior lines that must line up (in order). */
const ANCHOR_SIMILARITY_THRESHOLD = 0.5;
/** An anchor window may span at most this multiple of `old_string`'s line count. */
const MAX_ANCHOR_EXPANSION = 4;

const EOL_PATTERN = /\r\n|\n|\r/;
const EOL_PATTERN_GLOBAL = /\r\n|\n|\r/g;

interface LineInfo {
  /** Line text without its trailing end-of-line marker. */
  text: string;
  /** Character offset of the first character of {@link text}. */
  start: number;
}

/** Splits `content` into lines while tracking each line's char offset. */
function splitLinesWithOffsets(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  const matcher = new RegExp(EOL_PATTERN_GLOBAL);
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(content)) !== null) {
    lines.push({ text: content.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  lines.push({ text: content.slice(start), start });
  return lines;
}

/** The dominant line ending of `content` (CRLF if any CRLF is present). */
function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : '';
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indexOfFirstNonBlank(lines: string[]): number {
  return lines.findIndex(line => !isBlank(line));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/** Removes leading and trailing all-blank lines. */
function trimBoundaryBlankLines(lines: string[]): string[] {
  let startLine = 0;
  let endLine = lines.length - 1;
  while (startLine <= endLine && isBlank(lines[startLine])) startLine++;
  while (endLine >= startLine && isBlank(lines[endLine])) endLine--;
  return lines.slice(startLine, endLine + 1);
}

function normalizeEol(text: string, eol: string): string {
  return text.replace(EOL_PATTERN_GLOBAL, eol);
}

/** Reverses one level of `\n` / `\t` / `\r` / `\"` / `\'` / `\\` escaping. */
function unescapeOneLevel(text: string): string {
  return text.replace(/\\(n|t|r|"|'|\\)/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      default:
        return escaped; // '"', "'", or '\\' map to themselves
    }
  });
}

/**
 * True when `matchedLen` is far larger than `oldLen` (a signal that a tolerant
 * matcher bridged an unintended region). Exported for direct unit testing.
 */
export function isDisproportionate(matchedLen: number, oldLen: number): boolean {
  return matchedLen > DISPROPORTION_MIN_LEN && matchedLen > oldLen * DISPROPORTION_RATIO;
}

type LineNormalizer = (line: string) => string;

const trimmedNormalizer: LineNormalizer = line => line.trim();
const whitespaceNormalizer: LineNormalizer = line => line.trim().replace(/\s+/g, ' ');

/** Start-line indices where `oldLines` matches consecutively under `normalize`. */
function findBlockMatches(contentLines: LineInfo[], oldLines: string[], normalize: LineNormalizer): number[] {
  const blockLength = oldLines.length;
  const normalizedOld = oldLines.map(normalize);
  const starts: number[] = [];
  for (let i = 0; i + blockLength <= contentLines.length; i++) {
    let matched = true;
    for (let k = 0; k < blockLength; k++) {
      if (normalize(contentLines[i + k].text) !== normalizedOld[k]) {
        matched = false;
        break;
      }
    }
    if (matched) starts.push(i);
  }
  return starts;
}

interface AnchorMatch {
  startLine: number;
  endLine: number;
}

/**
 * Anchor matching: pin the first and last (trimmed) lines of the block, allow the
 * interior line count to drift, and require enough interior lines to line up in
 * order. Windows are bounded to {@link MAX_ANCHOR_EXPANSION}x the block length.
 * Similarity is measured against the window's own interior size (see
 * {@link interiorSimilarity}), so a window padded with unrelated lines is rejected
 * rather than silently accepted; the disproportion guard is a further backstop on
 * the resolved span.
 */
function findAnchorMatches(contentLines: LineInfo[], oldLines: string[]): AnchorMatch[] {
  const blockLength = oldLines.length;
  const firstAnchor = oldLines[0].trim();
  const lastAnchor = oldLines[blockLength - 1].trim();
  const interiorOld = oldLines.slice(1, blockLength - 1).map(line => line.trim());
  const maxWindowLines = blockLength * MAX_ANCHOR_EXPANSION;
  const minWindowLines = Math.max(ANCHOR_MIN_LINES, Math.floor(blockLength / 2));

  const matches: AnchorMatch[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].text.trim() !== firstAnchor) continue;
    for (let j = i + minWindowLines - 1; j < contentLines.length && j - i + 1 <= maxWindowLines; j++) {
      if (contentLines[j].text.trim() !== lastAnchor) continue;
      if (interiorSimilarity(contentLines, i, j, interiorOld) >= ANCHOR_SIMILARITY_THRESHOLD) {
        matches.push({ startLine: i, endLine: j });
      }
    }
  }
  return matches;
}

/**
 * Similarity of the window `(i, j)` to the old block's interior. `interiorOld`
 * lines must appear in order, and the score is divided by the *larger* of the
 * old interior and the window's own interior line count. Dividing by the window
 * size is what stops a window padded with unrelated lines (e.g. one that bridges
 * two adjacent blocks) from scoring highly on a single incidental match: such a
 * window has few matched lines relative to its size, so it falls below threshold.
 */
function interiorSimilarity(contentLines: LineInfo[], i: number, j: number, interiorOld: string[]): number {
  const windowInterior = j - i - 1;
  if (interiorOld.length === 0 && windowInterior === 0) return 1;
  let cursor = 0;
  for (let w = i + 1; w < j && cursor < interiorOld.length; w++) {
    if (contentLines[w].text.trim() === interiorOld[cursor]) cursor++;
  }
  return cursor / Math.max(interiorOld.length, windowInterior);
}

/**
 * Re-shapes `newString` (authored against `oldLines`' indentation) to sit at the
 * matched span's indentation, and rewrites its line endings to `eol`. Only a
 * uniform indent delta is applied; if indentation styles are incompatible
 * (mixed tabs/spaces) the text is left untouched apart from EOL normalization.
 */
function reshapeReplacement(oldLines: string[], matchedLines: string[], newString: string, eol: string): string {
  const newLines = newString.split(EOL_PATTERN);
  const oldAnchor = indexOfFirstNonBlank(oldLines);
  const matchedAnchor = indexOfFirstNonBlank(matchedLines);

  if (oldAnchor === -1 || matchedAnchor === -1) {
    return newLines.join(eol);
  }

  const oldIndent = leadingWhitespace(oldLines[oldAnchor]);
  const fileIndent = leadingWhitespace(matchedLines[matchedAnchor]);

  if (fileIndent === oldIndent) {
    return newLines.join(eol);
  }

  if (fileIndent.startsWith(oldIndent)) {
    const extraIndent = fileIndent.slice(oldIndent.length);
    return newLines.map(line => (isBlank(line) ? line : extraIndent + line)).join(eol);
  }

  if (oldIndent.startsWith(fileIndent)) {
    const removedIndent = oldIndent.slice(fileIndent.length);
    return newLines.map(line => (line.startsWith(removedIndent) ? line.slice(removedIndent.length) : line)).join(eol);
  }

  // Incompatible indentation (e.g. tabs vs spaces): leave content untouched.
  return newLines.join(eol);
}

/** Builds a result for a line-span match, applying the disproportion guard. */
function buildLineSpanResult(
  content: string,
  contentLines: LineInfo[],
  startLine: number,
  endLine: number,
  oldLines: string[],
  newString: string,
  strategy: FuzzyStrategy
): FuzzyMatchResult {
  const spanStart = contentLines[startLine].start;
  const lastLine = contentLines[endLine];
  const spanEnd = lastLine.start + lastLine.text.length;
  const matchedText = content.slice(spanStart, spanEnd);

  if (isDisproportionate(matchedText.length, oldLines.join('\n').length)) {
    throw new DisproportionateMatchError();
  }

  const matchedLines = contentLines.slice(startLine, endLine + 1).map(line => line.text);
  const replacement = reshapeReplacement(oldLines, matchedLines, newString, detectEol(content));

  return { matchedText, replacement, startIndex: spanStart, strategy };
}

/**
 * Attempts a validated fuzzy match. Returns `null` when no tolerant matcher finds
 * the block; throws {@link AmbiguousMatchError} / {@link DisproportionateMatchError}
 * when a match is found but is unsafe to apply.
 */
export function fuzzyMatch(content: string, oldString: string, newString: string): FuzzyMatchResult | null {
  const eol = detectEol(content);

  // 1. Escape-normalized exact: the model sent literal escapes (\n, \t, \").
  const unescaped = unescapeOneLevel(oldString);
  if (unescaped !== oldString && content.includes(unescaped)) {
    const occurrences = countOccurrences(content, unescaped);
    if (occurrences > 1) throw new AmbiguousMatchError(occurrences);
    // No disproportion guard here: unescaping only ever shortens `oldString`
    // (each 2-char escape collapses to 1 char), so the matched span can never be
    // larger than what the model supplied.
    return {
      matchedText: unescaped,
      replacement: normalizeEol(newString, eol),
      startIndex: content.indexOf(unescaped),
      strategy: 'escape-normalized',
    };
  }

  const contentLines = splitLinesWithOffsets(content);
  const oldLines = oldString.split(EOL_PATTERN);

  // 2-3. Line-level block matching, increasing tolerance.
  const lineMatchers: Array<{ strategy: FuzzyStrategy; normalize: LineNormalizer }> = [
    { strategy: 'line-trimmed', normalize: trimmedNormalizer },
    { strategy: 'whitespace-normalized', normalize: whitespaceNormalizer },
  ];
  for (const { strategy, normalize } of lineMatchers) {
    const starts = findBlockMatches(contentLines, oldLines, normalize);
    if (starts.length > 1) throw new AmbiguousMatchError(starts.length);
    if (starts.length === 1) {
      return buildLineSpanResult(
        content,
        contentLines,
        starts[0],
        starts[0] + oldLines.length - 1,
        oldLines,
        newString,
        strategy
      );
    }
  }

  // 4. Blank-line boundary: an added/removed blank line at the block's edges.
  const coreOldLines = trimBoundaryBlankLines(oldLines);
  if (coreOldLines.length > 0 && coreOldLines.length !== oldLines.length) {
    const starts = findBlockMatches(contentLines, coreOldLines, trimmedNormalizer);
    if (starts.length > 1) throw new AmbiguousMatchError(starts.length);
    if (starts.length === 1) {
      const coreNewString = trimBoundaryBlankLines(newString.split(EOL_PATTERN)).join(eol);
      return buildLineSpanResult(
        content,
        contentLines,
        starts[0],
        starts[0] + coreOldLines.length - 1,
        coreOldLines,
        coreNewString,
        'blank-line-boundary'
      );
    }
  }

  // 5. Block-anchor similarity: pin first/last line, tolerate interior drift.
  if (oldLines.length >= ANCHOR_MIN_LINES) {
    // Each (startLine, endLine) pair is generated at most once by the anchor
    // scan, so the match count is already the distinct-span count.
    const anchorMatches = findAnchorMatches(contentLines, oldLines);
    if (anchorMatches.length > 1) throw new AmbiguousMatchError(anchorMatches.length);
    if (anchorMatches.length === 1) {
      const best = anchorMatches[0];
      return buildLineSpanResult(
        content,
        contentLines,
        best.startLine,
        best.endLine,
        oldLines,
        newString,
        'block-anchor'
      );
    }
  }

  return null;
}
