import { Logger } from '@bike4mind/observability';
import {
  type ArtifactBlockMatch,
  ArtifactOperation,
  ArtifactType,
  mapMimeTypeToArtifactType,
  matchArtifactBlocks,
} from '@bike4mind/common';
import { hasSingleLineImportFrom } from './importStatements';
import {
  type ResultReplacer,
  replaceDirectTypeObjects,
  replaceEscapedResultObjects,
  replaceLazyResultObjects,
  replaceLogFormatResultObjects,
} from './toolOutputResultScan';

// Value is anchored to its own quote kind so a double-quoted value can contain
// apostrophes (title="Bob's App") and vice versa. Group 2 is the double-quoted
// body, group 3 the single-quoted one; exactly one matches.
const ATTRIBUTE_REGEX = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;

export interface ParsedArtifact {
  fullMatch: string;
  identifier?: string;
  type: ArtifactType;
  language?: string;
  title: string;
  content: string;
  operation: ArtifactOperation;
  startIndex: number;
  endIndex: number;
}

export interface ArtifactParseResult {
  artifacts: ParsedArtifact[];
  cleanedContent: string; // Content with artifact tags removed
}

/**
 * Drops every complete `<!--...-->`, leaving an unterminated `<!--` where it is.
 * A cursor pair rather than /<!--[\s\S]*?-->/g, whose lazy body re-scans to the end of
 * the input from every opening that never finds a closer: quadratic on a run of bare
 * `<!--` tokens. Exported so apps/client/app/utils/artifactParser.ts imports this copy
 * instead of keeping its own.
 */
export function stripHtmlComments(value: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = value.indexOf('<!--', cursor);
    if (open < 0) break;
    const close = value.indexOf('-->', open + '<!--'.length);
    // Closers only move forward, so no later opening has one either.
    if (close < 0) break;
    out += value.slice(cursor, open);
    cursor = close + '-->'.length;
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

/**
 * A "graphically empty" SVG has no drawable content - only the root <svg> wrapper
 * around whitespace and/or comments. Small local models sometimes emit such a stub
 * as a placeholder (e.g. `<svg ...><!-- fish illustration goes here --></svg>`),
 * which would otherwise render/persist as a blank canvas. Deliberately conservative:
 * only whitespace/comments count as empty, so it never drops an SVG with a real
 * element (it does miss rarer stubs like an empty `<g></g>`, which is acceptable).
 * Exported for tests.
 */
export function isSvgGraphicallyEmpty(svg: string): boolean {
  const withoutComments = stripHtmlComments(svg);
  // Self-closing root, e.g. `<svg .../>`, has no children.
  if (/^\s*<svg\b[^>]*\/>\s*$/i.test(withoutComments)) return true;
  const inner = withoutComments.replace(/^\s*<svg\b[^>]*>/i, '').replace(/<\/svg\s*>\s*$/i, '');
  return inner.trim().length === 0;
}

/**
 * How extractArtifactBlocks resolves a block whose `type` attribute is missing or unknown.
 *  - 'none': drop the block. Only extractArtifactBlocks' own default; no parser uses it.
 *  - 'language-then-code': try the `language` attribute, then fall back to 'code', and
 *    default `language` to 'text'. Both parseArtifacts (this module's, which feeds
 *    promptMeta.artifacts and DAG bubble-up, and the client's render path) use this, so
 *    an untyped block counts the same everywhere.
 */
export type ArtifactTypeFallback = 'none' | 'language-then-code';

export interface ExtractArtifactBlocksOptions {
  typeFallback?: ArtifactTypeFallback;
}

/**
 * Every `<artifact ...>...</artifact>` block in `content`, in source order, with its
 * attributes resolved and its position kept so callers can strip or replace the tag.
 * Shared by this module's parseArtifacts and the client's (apps/client/app/utils/artifactParser.ts),
 * which differ only in what they do with the tags afterwards.
 */
export function extractArtifactBlocks(content: string, options: ExtractArtifactBlocksOptions = {}): ParsedArtifact[] {
  const fallback = options.typeFallback ?? 'none';
  const artifacts: ParsedArtifact[] = [];

  for (const block of matchArtifactBlocks(content)) {
    const { index: startIndex, fullMatch, attrs: attributesString, body: artifactContent } = block;
    const endIndex = startIndex + fullMatch.length;

    const attributes: Record<string, string> = {};
    let attrMatch;
    ATTRIBUTE_REGEX.lastIndex = 0;

    while ((attrMatch = ATTRIBUTE_REGEX.exec(attributesString)) !== null) {
      const [, key, doubleQuoted, singleQuoted] = attrMatch;
      attributes[key] = doubleQuoted ?? singleQuoted;
    }

    const identifier = attributes.identifier;
    const title = attributes.title || 'Untitled Artifact';
    let language = attributes.language;

    let artifactType = mapMimeTypeToArtifactType(attributes.type || '');
    if (fallback === 'language-then-code') {
      if (!artifactType && language) artifactType = mapLanguageToArtifactType(language);
      if (!artifactType) artifactType = 'code';
      language = language || 'text';
    }
    if (!artifactType) continue;

    // An identifier seen on an earlier kept block makes this one an update.
    const operation: ArtifactOperation =
      identifier && artifacts.some(a => a.identifier === identifier) ? 'update' : 'create';

    artifacts.push({
      fullMatch,
      identifier,
      type: artifactType,
      language,
      title,
      content: artifactContent.trim(),
      operation,
      startIndex,
      endIndex,
    });
  }

  return artifacts;
}

/**
 * Parses Claude-style artifact syntax from text content
 *
 * Example syntax:
 * <artifact identifier="todo-app" type="application/vnd.ant.react" title="Todo List App">
 * // React component code here
 * </artifact>
 */
export function parseArtifacts(content: string): ArtifactParseResult {
  const artifacts = extractArtifactBlocks(content, { typeFallback: 'language-then-code' });
  let cleanedContent = content;

  // Remove artifact tags from content (in reverse order to maintain indices)
  artifacts
    .sort((a, b) => b.startIndex - a.startIndex)
    .forEach(artifact => {
      cleanedContent = cleanedContent.slice(0, artifact.startIndex) + cleanedContent.slice(artifact.endIndex);
    });

  return {
    // Drop graphically-empty SVG placeholders (markup already stripped above) so a
    // small model's blank `<svg>` stub never renders/persists as a blank artifact.
    artifacts: artifacts.filter(a => !(a.type === 'svg' && isSvgGraphicallyEmpty(a.content))),
    cleanedContent: cleanedContent.trim(),
  };
}

// mapMimeTypeToArtifactType is the single source of truth in @bike4mind/common.

/**
 * Maps a `language` attribute to an artifact type, for extractArtifactBlocks'
 * 'language-then-code' fallback when the MIME type maps to nothing.
 */
export function mapLanguageToArtifactType(language: string): ArtifactType | null {
  const normalized = language.toLowerCase().trim();

  // React/JSX
  if (normalized === 'jsx' || normalized === 'tsx' || normalized === 'react') {
    return 'react';
  }

  // JavaScript/TypeScript
  if (normalized === 'javascript' || normalized === 'js' || normalized === 'typescript' || normalized === 'ts') {
    return 'code';
  }

  // Python
  if (normalized === 'python' || normalized === 'py') {
    return 'python';
  }

  // Other programming languages
  if (
    normalized === 'java' ||
    normalized === 'cpp' ||
    normalized === 'c++' ||
    normalized === 'c' ||
    normalized === 'rust' ||
    normalized === 'go' ||
    normalized === 'golang' ||
    normalized === 'ruby' ||
    normalized === 'rb' ||
    normalized === 'php' ||
    normalized === 'swift' ||
    normalized === 'kotlin' ||
    normalized === 'csharp' ||
    normalized === 'cs' ||
    normalized === 'c#'
  ) {
    return 'code';
  }

  // Markup languages
  if (normalized === 'html' || normalized === 'xhtml') {
    return 'html';
  }
  if (normalized === 'svg') {
    return 'svg';
  }
  if (normalized === 'markdown' || normalized === 'md') {
    return 'code';
  }

  // Specialized visualizations
  if (normalized === 'mermaid') {
    return 'mermaid';
  }

  return null;
}

// Linear anchor checks for the fenced-code detectors below. Each detector used to
// encode a content requirement inside a `(?:.*\n)*?ANCHOR(?:\n.*)*?` regex that
// backtracks quadratically on a fence with no closing delimiter. Capturing the body
// with a single lazy group and moving the ANCHOR check here runs in linear time. The
// decision is unchanged on a single well-formed fence; a multi-fence body no longer
// over-matches. Two behaviours do change, both toward the intended reading: an anchor
// in a LATER fence no longer promotes an earlier one, and a bare `\r` or `U+2028`
// before the anchor now promotes, because `.` did not cross those but `split('\n')`
// keeps them in-line.

// True when some line has a declaration keyword followed, later on the SAME line, by
// a component token - the React detector's original requirement (case-insensitive).
// Checking the earliest declaration is equivalent to the old regex's backtracking:
// if any declaration has a component token after it, the earliest one does too.
function hasReactComponentLine(code: string): boolean {
  const DECLARATIONS = ['function', 'const', 'class'];
  const COMPONENT_TOKENS = ['component', 'app', 'export default'];
  for (const rawLine of code.split('\n')) {
    const line = rawLine.toLowerCase();
    let declStart = Infinity;
    let declEnd = -1;
    for (const decl of DECLARATIONS) {
      const at = line.indexOf(decl);
      if (at >= 0 && at < declStart) {
        declStart = at;
        declEnd = at + decl.length;
      }
    }
    if (declEnd < 0) continue;
    const afterDecl = line.slice(declEnd);
    if (COMPONENT_TOKENS.some(token => afterDecl.includes(token))) return true;
  }
  return false;
}

// The next two are exported for tests and other callers (hasReactComponentLine above is the
// loose half of the React decision; hasReactIndicators below is the strict half).

// A full HTML document: a <!DOCTYPE ...> followed later by a closing </html>.
export function hasFullHtmlDocument(code: string): boolean {
  const lower = code.toLowerCase();
  const doctype = lower.indexOf('<!doctype');
  if (doctype < 0) return false;
  return lower.indexOf('</html>', doctype + '<!doctype'.length) >= 0;
}

// A complete SVG: an opening <svg followed later by a closing </svg>.
export function hasCompleteSvg(code: string): boolean {
  const lower = code.toLowerCase();
  const open = lower.indexOf('<svg');
  if (open < 0) return false;
  return lower.indexOf('</svg>', open + '<svg'.length) >= 0;
}

const MERMAID_FENCE_OPEN = /```mermaid/gi;
const MERMAID_WS = /\s/;

/** CR, LINE SEPARATOR, PARAGRAPH SEPARATOR: the three characters `.` and `\n` together miss. */
function isMermaidBodyBreak(code: number): boolean {
  return code === 0x0d || code === 0x2028 || code === 0x2029;
}

/**
 * Mermaid fences, as `/```mermaid\s*((?:.*\n)*?)```/gi` matched them - the regex shipped on
 * main; the differential suite pins the scanner against it and against the tightened
 * `((?:\S(?:.|\n)*?\n)??)` body this branch passed through on the way here. But without the
 * per-fence rescan: an unclosed fence used to send a fresh lazy scan to the end of the input for
 * every later fence, which is quadratic in the number of fences. Leading whitespace stays OUTSIDE
 * the body exactly as the old `\s*` had it, and an empty body still wins over a later closer
 * because the old group was lazily optional.
 *
 * The body could only ever end at a newline sitting directly before a closing fence, and - the
 * constraint no reader would guess from the fence syntax - the body was built out of `.` and `\n`
 * alone, so it could never contain a CR, a LINE SEPARATOR or a PARAGRAPH SEPARATOR.
 * Both position sets are indexed once and walked with cursors that only move forward, since each
 * fence's body starts past the previous one's. A fence whose nearest closer sits past one of
 * those break characters fails outright instead of reaching for a later closer: every later
 * closer is further right, so it would cross the same character.
 */
export function scanMermaidFences(source: string): { start: number; end: number; body: string }[] {
  // Probe before indexing so fence-free content (the common case) costs one scan, not three.
  // The regex is module-scoped and /g, so reset its lastIndex first and then feed this very
  // match to the loop rather than re-running it from wherever the probe left off.
  MERMAID_FENCE_OPEN.lastIndex = 0;
  const firstOpen = MERMAID_FENCE_OPEN.exec(source);
  if (!firstOpen) return [];

  const closers: number[] = [];
  for (let at = source.indexOf('\n```'); at !== -1; at = source.indexOf('\n```', at + 1)) closers.push(at);
  const breaks: number[] = [];
  for (let at = 0; at < source.length; at++) if (isMermaidBodyBreak(source.charCodeAt(at))) breaks.push(at);

  const fences: { start: number; end: number; body: string }[] = [];
  let closerAt = 0;
  let breakAt = 0;
  for (let open: RegExpExecArray | null = firstOpen; open; open = MERMAID_FENCE_OPEN.exec(source)) {
    const start = open.index;
    let body = start + open[0].length;
    while (body < source.length && MERMAID_WS.test(source[body])) body++;
    if (source.startsWith('```', body)) {
      fences.push({ start, end: body + 3, body: '' });
      MERMAID_FENCE_OPEN.lastIndex = body + 3;
      continue;
    }
    // A body needs at least its leading non-whitespace character, so the closer has to sit past it.
    while (closerAt < closers.length && closers[closerAt] <= body) closerAt++;
    // Nothing left to close this fence, and any later fence starts further right, so none either.
    if (closerAt === closers.length) continue;
    while (breakAt < breaks.length && breaks[breakAt] < body) breakAt++;
    const close = closers[closerAt];
    if (breakAt < breaks.length && breaks[breakAt] < close) continue;
    fences.push({ start, end: close + 4, body: source.slice(body, close + 1) });
    MERMAID_FENCE_OPEN.lastIndex = close + 4;
  }
  return fences;
}

function replaceMermaidFences(source: string, replace: (fullMatch: string, body: string) => string): string {
  const fences = scanMermaidFences(source);
  if (!fences.length) return source;
  let out = '';
  let at = 0;
  for (const fence of fences) {
    out += source.slice(at, fence.start) + replace(source.slice(fence.start, fence.end), fence.body);
    at = fence.end;
  }
  return out + source.slice(at);
}

/**
 * Info-string token marking a fence that holds a verbatim quote of tool output. Such a
 * region is never promoted to an artifact, by any detector in this module (the client render
 * path converts through the same code). History replay must strip it before the model sees the
 * reply again.
 */
export const TOOL_OUTPUT_MARKER = 'b4m-tool-output';

const TOOL_OUTPUT_OPENER = new RegExp(`^ {0,3}(~{3,})[\\w-]*[ \\t]+${TOOL_OUTPUT_MARKER}[ \\t]*$`);

export interface ToolOutputMask {
  /** The content with every marked region replaced by an opaque placeholder. */
  masked: string;
  /** Registers one more region and returns its placeholder. */
  protect(region: string): string;
  /** Puts every region back in place of its placeholder. */
  restore(value: string): string;
  /** True when the value contains a placeholder, i.e. a span that must not be promoted. */
  holds(value: string): boolean;
}

function stripLineEnd(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Length of a line made only of tildes (surrounding whitespace allowed), else 0. */
function tildeLineRun(line: string): number {
  const trimmed = line.trim();
  for (let i = 0; i < trimmed.length; i++) if (trimmed[i] !== '~') return 0;
  return trimmed.length;
}

/**
 * Hides every closed `~~~<lang> b4m-tool-output` fence behind a placeholder so no
 * detector can promote its body or count the backticks inside it. An opener with no
 * closer is not a region. The placeholder uses a private-use character absent from the
 * content, so it cannot collide with reply text.
 */
export function maskToolOutputRegions(content: string): ToolOutputMask {
  const used = new Set<number>();
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c >= 0xe000) used.add(c);
  }
  let code = 0xe000;
  while (used.has(code)) code++;
  const sentinel = String.fromCharCode(code);
  const regions: string[] = [];
  const protect = (region: string): string => {
    regions.push(region);
    return `${sentinel}${regions.length - 1}${sentinel}`;
  };
  const restore = (value: string): string =>
    regions.length === 0
      ? value
      : value.replace(new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g'), (match, index: string) => {
          const region = regions[Number(index)];
          return region === undefined ? match : region;
        });
  const holds = (value: string): boolean => regions.length > 0 && value.includes(sentinel);

  if (!content.includes(TOOL_OUTPUT_MARKER)) return { masked: content, protect, restore, holds };

  // One pass collects openers and closers; a suffix max of closer lengths answers "is there
  // any closer long enough ahead" in O(1), so an unclosed opener never rescans to the end.
  const openers: { start: number; run: number }[] = [];
  const closers: { start: number; end: number; run: number }[] = [];
  for (let lineStart = 0; lineStart < content.length;) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = stripLineEnd(content.slice(lineStart, lineEnd));
    const opener = TOOL_OUTPUT_OPENER.exec(line);
    if (opener) {
      openers.push({ start: lineStart, run: opener[1].length });
    } else {
      const run = tildeLineRun(line);
      if (run >= 3) closers.push({ start: lineStart, end: lineStart + line.length, run });
    }
    lineStart = lineEnd + 1;
  }
  const longestAhead: number[] = new Array(closers.length + 1).fill(0);
  for (let i = closers.length - 1; i >= 0; i--) longestAhead[i] = Math.max(closers[i].run, longestAhead[i + 1]);

  let masked = '';
  let copiedTo = 0;
  let next = 0;
  for (const opener of openers) {
    if (opener.start < copiedTo) continue;
    while (next < closers.length && closers[next].start < opener.start) next++;
    if (longestAhead[next] < opener.run) continue;
    let closer = next;
    while (closers[closer].run < opener.run) closer++;
    masked += content.slice(copiedTo, opener.start) + protect(content.slice(opener.start, closers[closer].end));
    copiedTo = closers[closer].end;
    next = closer + 1;
  }
  return { masked: masked + content.slice(copiedTo), protect, restore, holds };
}

const TOOL_OUTPUT_OPENER_MARK = new RegExp(`^( {0,3}~{3,}[\\w-]*)[ \\t]+${TOOL_OUTPUT_MARKER}([ \\t]*\\r?)$`, 'gm');

/** Drops the marker from every tool-output fence opener so replayed history never shows it to the model. */
export function stripToolOutputMarker(value: string): string {
  return value.includes(TOOL_OUTPUT_MARKER) ? value.replace(TOOL_OUTPUT_OPENER_MARK, '$1$2') : value;
}

function longestTildeRun(value: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < value.length; i++) {
    run = value[i] === '~' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * The marked fence that replaces a promotable span found to be a tool echo. Body bytes are
 * kept; a newline is added only where the fence would otherwise not start or end a line.
 */
function toolOutputFence(lang: string, body: string, before: string, after: string): string {
  const tildes = '~'.repeat(Math.max(3, longestTildeRun(body) + 1));
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const open = body.startsWith('\n') || body.startsWith('\r\n') ? '' : '\n';
  const close = body.endsWith('\n') ? '' : '\n';
  const trail = after === '' || after.startsWith('\n') || after.startsWith('\r\n') ? '' : '\n';
  return `${lead}${tildes}${lang} ${TOOL_OUTPUT_MARKER}${open}${body}${close}${tildes}${trail}`;
}

export interface ConvertCodeBlocksOptions {
  /** True when a candidate body is a verbatim quote of this turn's tool output. */
  isToolEcho?: (body: string) => boolean;
  /**
   * Rewrite the inner fences of a ```markdown block to ~~~ so they cannot close it early. A
   * render fix, not a promotion: only the client render path (parseArtifactsWithFallback) sets it.
   * Off for the server, which persists its output, because the greedy match also rewrites fences
   * after the block closes.
   */
  rewriteNestedMarkdown?: boolean;
}

/**
 * Post-processes AI responses to detect code blocks that should be artifacts
 * and converts them to proper artifact syntax as a fallback
 */
export function convertCodeBlocksToArtifacts(content: string, options: ConvertCodeBlocksOptions = {}): string {
  return transformCodeBlocks(content, options, false);
}

/**
 * Rewrites only the spans convertCodeBlocksToArtifacts would promote AND isToolEcho flags,
 * into marked fences; everything else stays byte-identical. For replies stored raw and
 * parsed later (the agent path), where promoting here would change what gets persisted.
 */
export function markToolEchoes(content: string, isToolEcho: (body: string) => boolean): string {
  return transformCodeBlocks(content, { isToolEcho }, true);
}

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, ' ');

// Single-line only: the body lines of a multi-line `accDescr {` block still count.
const MERMAID_DEDUPE_IGNORED_LINE = /^(?:title|accTitle|accDescr)\b|^%%/;

/** Dedupe form of a mermaid body: title, accessibility and comment lines dropped, whitespace normalized. */
const mermaidDedupeLines = (value: string): string[] =>
  value.split('\n').filter(line => !MERMAID_DEDUPE_IGNORED_LINE.test(line.trim()));
const normalizeMermaid = (value: string): string => normalizeWhitespace(mermaidDedupeLines(value).join('\n'));

/**
 * Protects every complete artifact span from the detectors and collects normalized mermaid bodies.
 * A span wrapping a tool-output placeholder is not protected itself, but artifacts inside it still are.
 */
function protectArtifactSpans(content: string, mask: ToolOutputMask): { masked: string; mermaidBodies: Set<string> } {
  const mermaidBodies = new Set<string>();
  const spans: Array<[number, number]> = [];
  // restore() is single-pass, so a span wrapping an already-protected region cannot itself be protected;
  // the scan descends into it instead, so an inner artifact sharing its closer is still found.
  const holdsPlaceholder = (block: ArtifactBlockMatch) => mask.holds(block.fullMatch);
  for (const block of matchArtifactBlocks(content, holdsPlaceholder)) {
    const type = Array.from(block.attrs.matchAll(ATTRIBUTE_REGEX))
      .filter(m => m[1] === 'type')
      .pop();
    if ((type?.[2] ?? type?.[3]) === 'application/vnd.ant.mermaid') mermaidBodies.add(normalizeMermaid(block.body));
    if (holdsPlaceholder(block)) continue;
    // Ordered and disjoint: the scan only resumes inside a block that does not become a span.
    spans.push([block.index, block.index + block.fullMatch.length]);
  }

  let masked = '';
  let copiedTo = 0;
  for (const [start, end] of spans) {
    masked += content.slice(copiedTo, start) + mask.protect(content.slice(start, end));
    copiedTo = end;
  }
  return { masked: masked + content.slice(copiedTo), mermaidBodies };
}

// Fixed-width, clock-free id suffix: 32-bit FNV-1a in base36. Core also runs in the browser, so
// no node:crypto. Collisions only matter between two different tool outputs in one reply.
function hashBody(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * A self-closing tag, e.g. `<path d="..."/>`, as `/<[a-z]+[^>]*\/>/` matched it. That
 * pattern re-scans to the first `>` after every `<` - to the end of input when none
 * follows - so this scans each character of `code` once instead: `[^>]*` cannot cross a
 * `>`, so a candidate can only end at the first `>` after its own opening, and a cached
 * `close` at or past `at + 2` is still that first `>` (a nearer one would have been found
 * when the cursor was set).
 */
export function hasSelfClosingTag(code: string): boolean {
  let close = -1;
  for (let at = code.indexOf('<'); at >= 0; at = code.indexOf('<', at + 1)) {
    const nameChar = code.charCodeAt(at + 1);
    if (nameChar < 97 || nameChar > 122) continue;
    if (close < at + 2) {
      close = code.indexOf('>', at + 2);
      // No `>` after this opening means none after any later one either.
      if (close < 0) return false;
    }
    if (close >= at + 3 && code[close - 1] === '/') return true;
  }
  return false;
}

/**
 * Sanitizes model-controlled text bound for a title="..." attribute in a tag this file
 * rebuilds. The artifact attribute parser (ATTRIBUTE_REGEX) has no escape mechanism, so a
 * " would truncate the attribute and leave the rest to be read as further attributes.
 * parseArtifacts here is quote-aware, but the repo's other artifact matchers
 * (sharedToolBuilder, notebookCurationService, openaiBackend) match attributes as [^>],
 * so a < or > reaching them closes the tag early; newlines break the single-line ones.
 * extractHTMLTitle applies the quote half of this rule to a <title> element.
 * The server-side twin is sanitizeArtifactTitle in b4m-core services
 * (llm/tools/utils/artifactEmission). It converts quotes to typographic ones rather than
 * stripping them, because there the pristine title also survives in the artifact JSON body.
 * Takes unknown because the callers read it out of parsed tool-output JSON, where a
 * title need not be a string; each caller's own default covers a value that coerces
 * to empty.
 */
function sanitizeToolOutputTitle(title: unknown): string {
  return String(title ?? '')
    .replace(/[<>"]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/**
 * Escapes the literal "</artifact>" sequence in a JSON artifact body so it cannot truncate
 * parseArtifacts' non-greedy body match and leave a following "<artifact ...>" to be read
 * as a second, model-chosen artifact. JSON.parse reads "\/" as "/", so the consumer
 * restores the original losslessly. Twin of escapeArtifactBodyJson in b4m-core services
 * (llm/tools/utils/artifactEmission), which this package cannot import; keep in sync.
 */
function escapeArtifactBodyJson(body: string): string {
  return body.replace(/<\/artifact>/gi, '<\\/artifact>');
}

/**
 * Same protection for a RAW (non-JSON) body, where the JSON backslash escape would render
 * as garbage. Matches the bare "<artifact"/"</artifact>" the parsers match and no more.
 * Twin of stripArtifactTagsFromRawBody in b4m-core services; keep in sync.
 */
function stripArtifactTagsFromRawBody(body: string): string {
  return body.replace(/<(\/?)artifact\b/gi, '&lt;$1artifact');
}

/**
 * Names an error for a log line without its message. This runs on the server chat path, which
 * must log no reply text, and V8's JSON.parse message quotes the input it failed on.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface ToolOutputEchoes {
  isToolEcho?: (body: string) => boolean;
  /** Replacement for an echoed match; `offset` indexes `input`, the text the match was found in. */
  mark: (match: string, offset: number, input: string) => string;
  /** Mark echoes only: every other match stays as it is (markToolEchoes). */
  only: boolean;
}

/**
 * Detects tool outputs (JSON responses from tools) and converts them to artifact syntax.
 * Ids are derived from the body (hashBody), not a clock: this now runs server-side too, and the
 * same reply must mint the same identifier on every pass for persistence to stay idempotent.
 */
function convertToolOutputsToArtifacts(
  content: string,
  holds: (value: string) => boolean,
  echoes: ToolOutputEchoes
): string {
  // Look for any JSON-like structure that contains type field with our target types
  // This approach is more forgiving of escaping variations
  const typePattern = /(?:rechart|recharts|mermaid)/g;
  const hasTargetType = typePattern.test(content);

  if (!hasTargetType) {
    return content;
  }

  // Try to find and extract JSON objects that contain our artifact types
  // We'll look for various patterns of escaping around the "result" field
  // Patterns 1, 3, 4 and 5 are linear scanners (./toolOutputResultScan) with the same results
  // as the regexes they replaced, which were quadratic on repeated unclosed prefixes or braces.
  const steps: Array<(text: string, replacer: ResultReplacer) => string> = [
    // Pattern 1: Standard result field with escaped JSON (most common from logs)
    replaceEscapedResultObjects,
    // Pattern 2: Result field with simpler escaping
    (text, replacer) => text.replace(/"result":\s*"(\{[^"]*(?:\\"[^"]*)*\})"/g, replacer),
    // Pattern 3: More permissive result field matching
    replaceLazyResultObjects,
    // Pattern 4: Direct JSON object (less common but possible)
    replaceDirectTypeObjects,
    // Pattern 5: Very specific pattern for the exact log format
    replaceLogFormatResultObjects,
  ];

  let processedContent = content;

  for (const step of steps) {
    const input = processedContent;
    processedContent = step(input, (match, captured, offset) => {
      if (holds(match)) return match;
      if (echoes.isToolEcho?.(captured || match)) return echoes.mark(match, offset, input);
      if (echoes.only) return match;
      try {
        let jsonString = captured || match;

        // Handle multiple levels of escaping - improved with error recovery
        let previousString = '';
        let iterations = 0;
        const maxIterations = 10; // Reduced for performance

        try {
          while (jsonString !== previousString && iterations < maxIterations && jsonString.includes('\\')) {
            previousString = jsonString;
            // More controlled unescaping - handle common patterns
            jsonString = jsonString
              .replace(/\\\\\\\\\"/g, '"') // 4 backslashes + quote -> quote
              .replace(/\\\\\"/g, '"') // 2 backslashes + quote -> quote
              .replace(/\\\"/g, '"') // 1 backslash + quote -> quote
              .replace(/\\\\\\\\\\/g, '\\') // 4 backslashes -> 1 backslash
              .replace(/\\\\\\/g, '\\') // 2 backslashes -> 1 backslash
              .replace(/\\\\/g, '\\') // Regular backslash escape
              .replace(/\\n/g, '\n') // Handle newlines
              .replace(/\\t/g, '\t') // Handle tabs
              .replace(/\\r/g, '\r'); // Handle carriage returns
            iterations++;
          }
        } catch (unescapeError) {
          Logger.globalInstance.warn('Error during string unescaping, using original:', errorName(unescapeError));
          jsonString = captured || match; // Fallback to original
        }

        const toolOutput = JSON.parse(jsonString);

        if ((toolOutput.type === 'rechart' || toolOutput.type === 'recharts') && toolOutput.content) {
          const title =
            sanitizeToolOutputTitle(toolOutput.metadata?.title || 'Interactive Chart') || 'Interactive Chart';

          // Validate recharts content structure
          let rechartsContent;
          try {
            if (typeof toolOutput.content === 'string') {
              rechartsContent = JSON.parse(toolOutput.content);
            } else {
              rechartsContent = toolOutput.content;
            }

            // Validate required fields for recharts
            if (!rechartsContent.chartType || !rechartsContent.data) {
              Logger.globalInstance.warn('Invalid recharts config: missing chartType or data');
              return match; // Return original if validation fails
            }

            const rechartsBody =
              typeof toolOutput.content === 'string' ? toolOutput.content : JSON.stringify(toolOutput.content);

            const identifier = `recharts-tool-${hashBody(rechartsBody)}`;
            return `<artifact identifier="${identifier}" type="application/vnd.ant.recharts" title="${title}">
${escapeArtifactBodyJson(rechartsBody)}
</artifact>`;
          } catch (validationError) {
            Logger.globalInstance.warn('Failed to validate recharts content:', errorName(validationError));
            return match; // Return original if validation fails
          }
        }

        if (toolOutput.type === 'mermaid' && toolOutput.content) {
          const title = sanitizeToolOutputTitle(toolOutput.metadata?.title || 'Mermaid Diagram') || 'Mermaid Diagram';
          const mermaidBody = stripArtifactTagsFromRawBody(String(toolOutput.content));
          const identifier = `mermaid-tool-${hashBody(mermaidBody)}`;

          const artifactSyntax = `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">
${mermaidBody}
</artifact>`;

          return artifactSyntax;
        }
      } catch (error) {
        Logger.globalInstance.warn('Failed to parse tool output JSON:', errorName(error), {
          length: (captured || match).length,
        });
      }

      return match;
    });
  }

  // Deliberately no tail fallback below this loop. The one that used to sit here could
  // not capture an escaped quote, so it never promoted anything, and its scan was
  // quadratic on a payload that carried no closing brace.
  return processedContent;
}

// Search-window bound for the five React indicator predicates below. Each is linear on
// its own, as are the other regex predicates here (the html-fragment tag check, the
// python gates, and core's looksLikeHtml and promoteBareHtmlDocument scans), which stay
// uncapped; this only keeps five passes over the same fence body from adding up. It is
// not a body-length cap: an indicator inside the window still promotes the full,
// untruncated body, and an indicator past the window leaves the fence a plain code block.
const MAX_FENCE_SCAN_CHARS = 256000;

/**
 * Extracts a title from Python code
 * Looks for docstrings, main function names, or class definitions
 */
function extractPythonTitle(code: string): string | null {
  // Try to find a module-level docstring (triple quotes at start)
  const docstringMatch = code.match(/^(?:'''|""")([^'"]+)(?:'''|""")/m);
  if (docstringMatch) {
    // Take first line of docstring as title
    const firstLine = docstringMatch[1].trim().split('\n')[0];
    if (firstLine && firstLine.length <= 50) return firstLine;
  }

  // Try to find main class name
  const classMatch = code.match(/^class\s+([A-Z][a-zA-Z0-9_]*)/m);
  if (classMatch) return classMatch[1];

  // Try to find main function name (prefer main or descriptive names)
  const mainMatch = code.match(/^def\s+(main|run|execute|process)\s*\(/m);
  if (mainMatch) return `${mainMatch[1]}()`;

  // Try any function definition
  const funcMatch = code.match(/^def\s+([a-z_][a-z0-9_]*)\s*\(/m);
  if (funcMatch) return funcMatch[1];

  return null;
}

// Core's original React rule: a declaration + component token on one line, plus a hook,
// default export or function/return.
function looksLikeReactLoose(code: string): boolean {
  if (!hasReactComponentLine(code)) return false;
  return (
    code.includes('useState') ||
    code.includes('useEffect') ||
    code.includes('export default') ||
    (code.includes('function') && code.includes('return'))
  );
}

// The stricter rule: at least 2 of 5 React indicators, counted over a capped prefix so five
// predicates cannot each rescan a large fence body. A closed fence whose only indicators sit past
// the window stays a plain code block.
function hasReactIndicators(code: string): boolean {
  const scanContent = code.slice(0, MAX_FENCE_SCAN_CHARS);
  const hasReactHooks =
    /\buse(State|Effect|Context|Reducer|Callback|Memo|Ref|ImperativeHandle|LayoutEffect|DebugValue)\b/.test(
      scanContent
    );
  const hasJSXSyntax = /<[A-Z][a-zA-Z0-9]*[\s\/>]/.test(scanContent) || hasSelfClosingTag(scanContent);
  const hasReactImport = hasSingleLineImportFrom(scanContent, 'react');
  const hasReactComponent = /extends\s+(?:React\.)?Component\b/.test(scanContent);
  const hasJSXReturn = /return\s*\(\s*</.test(scanContent);
  return [hasReactHooks, hasJSXSyntax, hasReactImport, hasReactComponent, hasJSXReturn].filter(Boolean).length >= 2;
}

interface FenceOpener {
  char: string;
  run: number;
  info: string;
}

// Any indent, not CommonMark's 0-3 spaces: a fence nested under a list item sits 4+ deep and still
// renders as a fence, and the lazy ``` regexes of the other detectors ignore indent too.
function fenceIndent(line: string): number {
  let at = 0;
  while (line[at] === ' ' || line[at] === '\t') at++;
  return at;
}

/** Fence opener: indent, then 3+ backticks or tildes; a backtick info string has no backtick. */
function parseFenceOpener(line: string): FenceOpener | null {
  const at = fenceIndent(line);
  const char = line[at];
  if (char !== '`' && char !== '~') return null;
  let end = at;
  while (line[end] === char) end++;
  const info = stripLineEnd(line.slice(end));
  if (end - at < 3 || (char === '`' && info.includes('`'))) return null;
  return { char, run: end - at, info: info.trim() };
}

/**
 * End of the closer run that starts this line, or -1. Unlike CommonMark, text may follow the run:
 * the lazy ``` regexes of the other detectors close there too, and agreeing with them keeps a
 * second convert from re-pairing what the first one promoted (the parity harness's H3).
 */
function fenceCloserLength(line: string, opener: FenceOpener): number {
  const at = fenceIndent(line);
  let end = at;
  while (line[end] === opener.char) end++;
  return end - at >= opener.run ? end : -1;
}

interface FencedBlock {
  /** Start of the opener line. */
  start: number;
  /** End of the closer run; the end of the content when unclosed. */
  end: number;
  bodyStart: number;
  bodyEnd: number;
  info: string;
}

/**
 * Every fenced code block, by CommonMark line rules except fenceIndent's and fenceCloserLength's,
 * in one pass over the lines. An opener with no closer runs to the end of the content, as
 * CommonMark (and so the rendered reply) treats it.
 */
function scanFencedBlocks(content: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  for (let lineStart = 0; lineStart < content.length;) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const opener = parseFenceOpener(content.slice(lineStart, lineEnd));
    if (!opener) {
      lineStart = lineEnd + 1;
      continue;
    }
    const bodyStart = Math.min(lineEnd + 1, content.length);
    let block: FencedBlock = {
      start: lineStart,
      end: content.length,
      bodyStart,
      bodyEnd: content.length,
      info: opener.info,
    };
    let at = bodyStart;
    while (at < content.length) {
      const next = content.indexOf('\n', at);
      const end = next === -1 ? content.length : next;
      const closer = fenceCloserLength(content.slice(at, end), opener);
      if (closer >= 0) {
        block = { ...block, end: at + closer, bodyEnd: at };
        break;
      }
      at = end + 1;
    }
    blocks.push(block);
    // Text after the closer run, on the same line, is prose.
    const closerLineEnd = content.indexOf('\n', block.end);
    lineStart = closerLineEnd === -1 ? content.length : closerLineEnd + 1;
  }
  return blocks;
}

// Fences a tool-output object can be pasted in; any other info string labels code, e.g. a
// python dict literal, which stays code.
const TOOL_OUTPUT_FENCE_INFO = new Set(['', 'json', 'json5', 'jsonc', 'text', 'txt', 'plaintext']);
const isToolOutputFence = (block: FencedBlock): boolean =>
  TOOL_OUTPUT_FENCE_INFO.has(block.info.split(/\s/, 1)[0].toLowerCase());

const INLINE_CODE = /`[^`\n]+`/g;

/**
 * Rebuilds content with `prose` applied to text outside fences and inline code, and `fence`
 * applied to each tool-output fence; other code passes through. Both get the real neighboring
 * characters, from outside the piece when it starts or ends there.
 */
function mapOutsideCode(
  content: string,
  prose: (text: string, before: string, after: string) => string,
  fence: (code: string, body: string, info: string, before: string, after: string) => string
): string {
  const before = (at: number) => content.slice(Math.max(0, at - 1), at);
  const after = (at: number) => content.slice(at, at + 2);
  const mapProse = (from: number, to: number): string => {
    let out = '';
    let copied = from;
    for (const m of content.slice(from, to).matchAll(INLINE_CODE)) {
      const at = from + m.index;
      out += prose(content.slice(copied, at), before(copied), after(at)) + m[0];
      copied = at + m[0].length;
    }
    return out + prose(content.slice(copied, to), before(copied), after(to));
  };
  let out = '';
  let copied = 0;
  for (const block of scanFencedBlocks(content)) {
    const code = content.slice(block.start, block.end);
    const body = content.slice(block.bodyStart, block.bodyEnd);
    out +=
      mapProse(copied, block.start) +
      (isToolOutputFence(block) ? fence(code, body, block.info, before(block.start), after(block.end)) : code);
    copied = block.end;
  }
  return out + mapProse(copied, content.length);
}

function transformCodeBlocks(content: string, options: ConvertCodeBlocksOptions, echoOnly: boolean): string {
  const mask = maskToolOutputRegions(content);
  const spans = protectArtifactSpans(mask.masked, mask);
  content = spans.masked;
  const { mermaidBodies } = spans;
  const isDuplicateMermaid = (text: string) => mermaidBodies.size > 0 && mermaidBodies.has(normalizeMermaid(text));
  const { isToolEcho } = options;
  // Echoed spans become marked fences, protected at once so later passes skip them too.
  // A span that holds a placeholder wraps a protected region (tool output or an existing artifact);
  // promoting it would put that region back inside a new artifact when restore runs.
  const { holds } = mask;
  const echoFence = (lang: string, body: string, whole: string, start: number, end: number): string | null =>
    isToolEcho?.(body)
      ? mask.protect(toolOutputFence(lang, body, whole.slice(Math.max(0, start - 1), start), whole.slice(end, end + 2)))
      : null;

  // The fence patterns below put no \s* in front of the body group: it is greedy over
  // characters the lazy body matches anyway, so a fence label followed by a long
  // whitespace run and no closer backtracks quadratically. Every callback trims. Mermaid
  // fences are not in this set: their match set depends on that \s* skip between label and
  // body, so scanMermaidFences walks them by index instead.
  // React fences promote in two phases, because the order decides which fence wins when an
  // unclosed one swallows a later opener. The loose rule runs first, alongside html and svg;
  // the tsx/jsx label and the indicator count run after mermaid, so a fence they would
  // stretch across an svg or mermaid fence cannot eat its opener.
  const reactCodeBlockRegex = /```(tsx?|jsx|javascript|typescript)([\s\S]*?)```/gi;
  const promoteReactFences = (accepts: (language: string, code: string) => boolean) => {
    content = content.replace(
      reactCodeBlockRegex,
      (match, language: string, codeContent: string, offset: number, whole: string) => {
        if (holds(codeContent) || !accepts(language, codeContent)) return match;
        const echoed = echoFence(language, codeContent, whole, offset, offset + match.length);
        if (echoed !== null) return echoed;
        if (echoOnly) return match;
        const componentName = extractComponentName(codeContent) || 'component';
        const identifier = componentName.toLowerCase().replace(/[^a-z0-9]/g, '-');

        return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${componentName}">
${codeContent.trim()}
</artifact>`;
      }
    );
  };
  promoteReactFences((_language, code) => looksLikeReactLoose(code));

  // Detect full HTML-document code blocks (body captured linearly; see hasFullHtmlDocument).
  // A fence that is not a full document is left unchanged here so the fragment handler
  // below still promotes it. The two-tier split is the original behavior; what changed is
  // that two adjacent `html` fences are now two artifacts, where the old regex merged
  // them into one.
  const htmlCodeBlockRegex = /```html([\s\S]*?)```/gi;

  content = content.replace(htmlCodeBlockRegex, (match, codeContent, offset: number, whole: string) => {
    if (!hasFullHtmlDocument(codeContent) || holds(codeContent)) return match;
    const echoed = echoFence('html', codeContent, whole, offset, offset + match.length);
    if (echoed !== null) return echoed;
    if (echoOnly) return match;
    const title = sanitizeHTMLTitle(extractHTMLTitle(codeContent), 'HTML Page');
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Promote ```html fences that lack a full <!DOCTYPE>...</html> document (HTML
  // fragments). The DOCTYPE-requiring regex above already converted full documents,
  // so any remaining ```html fence is a fragment: still better presented as a
  // previewable artifact than left as a raw code block (parser gap C).
  const htmlFragmentFenceRegex = /```html([\s\S]*?)```/gi;
  content = content.replace(htmlFragmentFenceRegex, (match, codeContent, offset: number, whole: string) => {
    // Require at least one HTML tag so a mislabeled fence of plain text is left alone.
    if (!/<[a-z][a-z0-9]*[\s/>]/i.test(codeContent) || holds(codeContent)) return match;
    const echoed = echoFence('html', codeContent, whole, offset, offset + match.length);
    if (echoed !== null) return echoed;
    if (echoOnly) return match;
    const title = sanitizeHTMLTitle(extractHTMLTitle(codeContent), 'HTML Snippet');
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Detect SVG code blocks (body captured linearly; see hasCompleteSvg)
  const svgCodeBlockRegex = /```svg([\s\S]*?)```/gi;

  content = content.replace(svgCodeBlockRegex, (match, codeContent) => {
    if (echoOnly || holds(codeContent)) return match;
    // Not a complete <svg>...</svg> - leave the fence unchanged.
    if (!hasCompleteSvg(codeContent)) return match;
    const identifier = 'svg-graphic';

    return `<artifact identifier="${identifier}" type="image/svg+xml" title="SVG Graphic">
${codeContent.trim()}
</artifact>`;
  });

  // Detect Mermaid code blocks and mixed content.
  content = replaceMermaidFences(content, (fullMatch, codeContent) => {
    if (echoOnly || holds(codeContent) || isDuplicateMermaid(codeContent)) return fullMatch;
    // Clean and validate the Mermaid syntax
    const { isValid, cleanedContent, errors } = validateMermaidSyntax(codeContent);

    if (isValid && cleanedContent.trim()) {
      const diagramType = extractMermaidDiagramType(cleanedContent);
      const identifier = `mermaid-${diagramType}`;
      const title = `${diagramType.charAt(0).toUpperCase() + diagramType.slice(1)} Diagram`;

      return `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">${cleanedContent}</artifact>`;
    } else {
      // Count only: the messages quote diagram lines, and reply text stays out of server logs.
      Logger.globalInstance.warn('Mermaid validation failed:', { errorCount: errors.length });
      return fullMatch;
    }
  });

  content = promoteToolCallJsonArtifact(content, holds, { fence: echoFence, only: echoOnly });

  content = promoteBareHtmlDocument(content, holds, { fence: echoFence, only: echoOnly });

  // Everything promoted so far is an artifact span now; protect those too, so the passes below
  // cannot wrap one in a second artifact when an unclosed fence spans it.
  content = protectArtifactSpans(content, mask).masked;

  // Bare tool-output JSON a model pasted into the reply, outside code or in a json/text fence.
  // An echo becomes a protected marked fence so a later convert without isToolEcho skips it too;
  // a "result": "..." chunk is fenced as matched, splitting the JSON string that quoted it.
  const convertToolOutputs = (text: string, mark: ToolOutputEchoes['mark']) =>
    convertToolOutputsToArtifacts(text, holds, { isToolEcho, mark, only: echoOnly });
  content = mapOutsideCode(
    content,
    (text, before, after) =>
      convertToolOutputs(text, (match, offset, input) => {
        const end = offset + match.length;
        const neighborBefore = offset > 0 ? input[offset - 1] : before;
        const neighborAfter = (input.slice(end, end + 2) + after).slice(0, 2);
        return mask.protect(toolOutputFence('json', match, neighborBefore, neighborAfter));
      }),
    (code, body, info, before, after) => {
      // An echo anywhere in the fence marks the whole fence: it is one quote, so nothing in it promotes.
      let echoed = false;
      const converted = convertToolOutputs(code, match => {
        echoed = true;
        return match;
      });
      if (!echoed) return converted;
      const lang = /^[\w-]*/.exec(info)?.[0] ?? '';
      return mask.protect(toolOutputFence(lang, body, before, after));
    }
  );

  promoteReactFences((language, code) => language === 'tsx' || language === 'jsx' || hasReactIndicators(code));

  // Detect Python code blocks - convert substantial Python code to Python artifacts
  const pythonCodeBlockRegex = /```(python|py)([\s\S]*?)```/gi;

  content = content.replace(
    pythonCodeBlockRegex,
    (match, language: string, codeContent: string, offset: number, whole: string) => {
      if (holds(codeContent)) return match;
      const trimmedCode = codeContent.trim();

      // Only convert if it's substantial code (more than a simple one-liner)
      // This helps avoid converting simple inline examples
      const lineCount = trimmedCode.split('\n').length;
      const hasImports = /^(?:import|from)\s+\w+/m.test(trimmedCode);
      const hasDefinitions = /^(?:def|class)\s+\w+/m.test(trimmedCode);
      const hasPrint = /print\s*\(/.test(trimmedCode);
      const hasSubstantialCode = lineCount >= 3 || hasImports || hasDefinitions;

      // Keep simple examples as regular code blocks
      if (!hasSubstantialCode && !(hasPrint && lineCount >= 2)) return match;

      const echoed = echoFence(language, codeContent, whole, offset, offset + match.length);
      if (echoed !== null) return echoed;
      if (echoOnly) return match;

      const title = sanitizeHTMLTitle(extractPythonTitle(trimmedCode), 'Python Script');
      const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.python" title="${title}">
${trimmedCode}
</artifact>`;
    }
  );

  // See ConvertCodeBlocksOptions.rewriteNestedMarkdown. Never under echoOnly, which must leave
  // every other byte alone.
  if (options.rewriteNestedMarkdown && !echoOnly) {
    const markdownBlockRegex = /```markdown([\s\S]*)```/gi;
    content = content.replace(markdownBlockRegex, (_match, codeContent: string) => {
      const updatedContent = codeContent.replace(/```/g, '~~~');
      return `\`\`\`markdown${updatedContent}\`\`\``;
    });
  }

  return mask.restore(content);
}

/** Returns the protected marked fence when the span is a tool echo, else null. */
export type EchoFence = (lang: string, body: string, whole: string, start: number, end: number) => string | null;

/**
 * Tool-echo handling for the promoters below. Only transformCodeBlocks passes one, and only
 * server-side: the client render path calls the same convert without an isToolEcho matcher,
 * since it never sees tool output, and relies on the fences the server marked.
 */
export interface EchoMarking {
  fence: EchoFence;
  /** Mark echoes but promote nothing else (markToolEchoes). */
  only: boolean;
}

const NO_ECHO: EchoMarking = { fence: () => null, only: false };

/**
 * Promotes an artifact that a small local model emitted as a hallucinated tool
 * call instead of an <artifact> tag or ```html fence. Such models invent a
 * builder tool (e.g. build_html, which is not a real tool anywhere) and return
 * its call as JSON: a name plus an arguments object carrying the HTML as a
 * string. The call never executes, so the raw JSON would otherwise render as a
 * code block. Recognized strictly (tool-call shape AND an HTML-string argument)
 * so ordinary JSON is left alone.
 *
 * NOTE: this runs inside convertCodeBlocksToArtifacts, which EVERY backend (cloud
 * included) flows through, not just local/Ollama. The strict recognition - an
 * invented builder-tool name AND an HTML-string argument - is what keeps a cloud
 * model that merely SHOWS such tool-call JSON as an example from having it
 * swallowed and re-rendered as an artifact.
 */
export function promoteToolCallJsonArtifact(
  content: string,
  holds: (value: string) => boolean,
  echo: EchoMarking = NO_ECHO
): string {
  const { fence: echoFence, only: echoOnly } = echo;
  // Fence labels a model uses for a tool call; a ```html fence is handled above.
  // The negative lookahead stops ```tool matching inside ```tool_calls etc.
  const fenceRegex = /```(json|tool_code|tool)(?![a-z0-9_])([\s\S]*?)```/gi;
  const afterFences = content.replace(
    fenceRegex,
    (match, label: string, body: string, offset: number, whole: string) => {
      if (holds(body)) return match;
      const artifact = toolCallJsonToArtifact(body);
      if (!artifact) return match;
      return echoFence(label, body, whole, offset, offset + match.length) ?? (echoOnly ? match : artifact);
    }
  );
  if (afterFences !== content) return afterFences;

  // A model may also return the bare object as its entire reply (no fence).
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}') && !holds(trimmed)) {
    const artifact = toolCallJsonToArtifact(trimmed);
    if (artifact) {
      const start = content.indexOf(trimmed);
      const echoed = echoFence('json', trimmed, content, start, start + trimmed.length);
      return content.replace(trimmed, () => echoed ?? (echoOnly ? trimmed : artifact));
    }
  }
  return content;
}

/**
 * Parse one candidate as a tool call whose arguments carry an HTML string and
 * return the equivalent <artifact> markup, or null if it is not that shape.
 * Accepts the name/arguments key aliases small models improvise.
 */
function toolCallJsonToArtifact(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  let name: unknown;
  let args: unknown;
  const fn = obj.function;
  if (fn && typeof fn === 'object') {
    name = (fn as Record<string, unknown>).name;
    args = (fn as Record<string, unknown>).arguments;
  } else {
    name = obj.name ?? obj.function ?? obj.tool ?? obj.tool_name;
  }
  if (args === undefined) args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input;
  // Promote only an invented artifact-builder tool name (build_html, create_webpage,
  // render_page, generate_ui...). A real tool whose args merely include HTML, e.g.
  // send_html_email, must be left alone. Anchored so the leading verb is the tool's
  // purpose, not an "html" substring buried mid-name.
  if (
    typeof name !== 'string' ||
    !/^(build|create|render|make|generate|write)[-_]?(html|artifact|page|webpage|website|ui)/i.test(name) ||
    !args ||
    typeof args !== 'object'
  )
    return null;

  const html = Object.values(args as Record<string, unknown>).find(
    (v): v is string => typeof v === 'string' && looksLikeHtml(v)
  );
  if (!html) return null;

  const title = sanitizeHTMLTitle(extractHTMLTitle(html), 'HTML Page');
  const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${html.trim()}
</artifact>`;
}

/** Full-document marker or at least one HTML element tag. */
function looksLikeHtml(value: string): boolean {
  return /<!DOCTYPE\s+html/i.test(value) || /<[a-z][a-z0-9]*[\s/>]/i.test(value);
}

/**
 * Promotes a bare <!DOCTYPE html>...</html> (or <html>...</html>) document emitted as
 * raw markup with no code fence and no <artifact> wrapper. Neither parseArtifacts
 * (needs <artifact> tags) nor the fenced detectors catch this shape, so it would
 * otherwise render as raw HTML in the chat (parser gap B). Runs last so the
 * fence/artifact guards see all earlier conversions.
 */
export function promoteBareHtmlDocument(
  content: string,
  holds: (value: string) => boolean,
  echo: EchoMarking = NO_ECHO
): string {
  const { fence: echoFence, only: echoOnly } = echo;
  // Two forward cursors instead of one <html>...</html> pattern, and guard counts that
  // accumulate over the gap since the previous document instead of re-reading the whole
  // prefix: both of the old shapes re-scanned from the start of the message on every
  // candidate, so this pass cost time quadratic in the message length.
  const openRegex = /<!DOCTYPE\s+html|<html/gi;
  const closeRegex = /<\/html\s*>/gi;
  let out = '';
  let copiedTo = 0;
  let promoted = false;
  let scannedTo = 0;
  let fences = 0;
  let insideArtifact = false;
  let open: RegExpExecArray | null;
  while ((open = openRegex.exec(content)) !== null) {
    closeRegex.lastIndex = open.index + open[0].length;
    const close = closeRegex.exec(content);
    // Closers only move forward, so a later opening cannot have one either.
    if (!close) break;
    const start = open.index;
    const end = close.index + close[0].length;
    openRegex.lastIndex = end;

    const gap = content.slice(scannedTo, start);
    fences += (gap.match(/```/g) || []).length;
    // Same pairing as matchArtifactBlocks: an open tag stays open until the FIRST closer, so a
    // tag opened inside an unclosed one does not add depth.
    for (const tag of gap.matchAll(/<artifact\b|<\/artifact>/gi)) insideArtifact = tag[0][1] !== '/';
    scannedTo = start;

    // Skip a document sitting inside a code fence (odd number of ``` before it) or
    // inside an already-open <artifact> tag.
    if (fences % 2 === 1 || insideArtifact) continue;

    const doc = content.slice(start, end);
    if (holds(doc)) continue;
    out += content.slice(copiedTo, start);
    copiedTo = end;
    promoted = true;
    const echoed = echoFence('html', doc, content, start, end);
    if (echoed !== null || echoOnly) {
      out += echoed ?? doc;
      continue;
    }
    const title = sanitizeHTMLTitle(extractHTMLTitle(doc), 'HTML Page');
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    out += `<artifact identifier="${identifier}" type="text/html" title="${title}">
${doc.trim()}
</artifact>`;
  }
  return promoted ? out + content.slice(copiedTo) : content;
}

/**
 * Extracts component name from React code
 */
export function extractComponentName(code: string): string | null {
  // Try to find function component name
  const functionMatch = code.match(/function\s+([A-Z][a-zA-Z0-9]*)/);
  if (functionMatch) return functionMatch[1];

  // Try to find const component name
  const constMatch = code.match(/const\s+([A-Z][a-zA-Z0-9]*)\s*=/);
  if (constMatch) return constMatch[1];

  // Try to find class component name
  const classMatch = code.match(/class\s+([A-Z][a-zA-Z0-9]*)/);
  if (classMatch) return classMatch[1];

  return null;
}

// Same result as code.match(/<title>(.*?)<\/title>/i)?.[1] ?? null in one forward pass: that
// regex rescans to the line end from every opener, so repeated `<title>` runs in quadratic time.
export function extractHTMLTitle(code: string): string | null {
  const opener = /<title>/gi;
  const closer = /<\/title>/gi;
  const lineEnd = /[\n\r\u2028\u2029]/g;
  let closeAt = -1;
  let lineEndAt = -1;
  for (let open = opener.exec(code); open; open = opener.exec(code)) {
    const bodyStart = opener.lastIndex;
    if (closeAt < bodyStart) closeAt = nextMatchIndex(closer, code, bodyStart);
    if (closeAt === Infinity) return null;
    if (lineEndAt < bodyStart) lineEndAt = nextMatchIndex(lineEnd, code, bodyStart);
    if (closeAt < lineEndAt) return code.slice(bodyStart, closeAt);
  }
  return null;
}

function nextMatchIndex(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : Infinity;
}

// Strip <, >, and " before interpolating a document-controlled title into title="...".
// Some artifact attribute parsers are not quote-aware, so any of these characters would
// corrupt or prematurely close the tag. Falls back to `fallback` when stripping empties
// the string (e.g. a title that was only quotes).
export function sanitizeHTMLTitle(raw: string | null, fallback: string): string {
  const sanitized = (raw ?? '').replace(/[<>"]/g, '').trim();
  return sanitized || fallback;
}

/**
 * Extracts the diagram type from Mermaid content
 */
function extractMermaidDiagramType(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  const match = firstLine.match(
    /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|entityRelationshipDiagram|gantt|pie|mindmap|timeline|journey|gitgraph|requirementDiagram|c4Context|quadrantChart|xyChart|sankey|packet|architecture|block)/
  );
  return match ? match[1] : 'diagram';
}

/**
 * Cleans and validates Mermaid syntax from LLM-generated content
 */
export function cleanMermaidSyntax(content: string): string {
  // Remove markdown code block syntax if present
  const cleaned = content.replace(/^```mermaid\s*/gm, '').replace(/^```\s*$/gm, '');

  // Remove any mixed content after valid Mermaid syntax
  const lines = cleaned.split('\n');
  const mermaidLines: string[] = [];
  let foundMermaidStart = false;
  let foundInvalidContent = false;
  let sequence = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines
    if (!trimmedLine) {
      if (foundMermaidStart && !foundInvalidContent) {
        mermaidLines.push(line);
      }
      continue;
    }

    // Check for Mermaid diagram start
    if (!foundMermaidStart) {
      if (isMermaidDiagramStart(trimmedLine)) {
        foundMermaidStart = true;
        sequence = /^sequenceDiagram\b/.test(trimmedLine);
        mermaidLines.push(line);
        continue;
      }
      // Skip non-Mermaid content before diagram starts
      continue;
    }

    // If we've started Mermaid content, check if this line is valid Mermaid
    if (foundMermaidStart && !foundInvalidContent) {
      if (isMermaidSyntax(trimmedLine, sequence)) {
        mermaidLines.push(line);
      } else {
        // Found invalid content, stop processing
        foundInvalidContent = true;
        break;
      }
    }
  }

  return mermaidLines.join('\n').trim();
}

/**
 * Validates Mermaid syntax and checks for common issues
 */
export function validateMermaidSyntax(content: string): {
  isValid: boolean;
  errors: string[];
  cleanedContent: string;
} {
  const errors: string[] = [];
  const cleanedContent = cleanMermaidSyntax(content);

  if (!cleanedContent.trim()) {
    errors.push('Empty Mermaid content after cleaning');
    return { isValid: false, errors, cleanedContent };
  }

  const lines = cleanedContent
    .split('\n')
    .map(line => line.trim())
    .filter(line => line);

  // Check for diagram type declaration
  const firstLine = lines[0];
  if (!isMermaidDiagramStart(firstLine)) {
    errors.push('Missing or invalid diagram type declaration (e.g., "graph TD", "sequenceDiagram", etc.)');
  }

  // Check for incomplete syntax
  for (const line of lines) {
    if (line.includes('[') && !line.includes(']')) {
      errors.push(`Incomplete node definition: ${line}`);
    }
    if (line.includes('(') && !line.includes(')')) {
      errors.push(`Incomplete parentheses in: ${line}`);
    }
    if (line.includes('{') && !line.includes('}')) {
      errors.push(`Incomplete braces in: ${line}`);
    }
  }

  // Check for basic flow syntax validation
  const arrowPattern = /--?>|-->|==>/;
  const hasConnections = lines.some(line => arrowPattern.test(line));
  const hasNodes = lines.some(line => line.includes('[') || line.includes('(') || line.includes('{'));

  if (firstLine.startsWith('graph') || firstLine.startsWith('flowchart')) {
    if (!hasNodes && !hasConnections) {
      errors.push('Flowchart appears to have no nodes or connections');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    cleanedContent,
  };
}

/**
 * Checks if a line starts a Mermaid diagram
 */
function isMermaidDiagramStart(line: string): boolean {
  const diagramTypes = [
    'graph',
    'flowchart',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'entityRelationshipDiagram',
    'gantt',
    'pie',
    'mindmap',
    'timeline',
    'journey',
    'gitgraph',
    'requirementDiagram',
    'c4Context',
    'quadrantChart',
    'xyChart',
    'sankey',
    'packet',
    'architecture',
    'block',
  ];

  return diagramTypes.some(
    type => line.startsWith(type) || line.startsWith(`${type} `) || line.startsWith(`${type}\t`)
  );
}

// Only valid inside a sequenceDiagram: words like `option` or `title` are ordinary prose elsewhere.
const SEQUENCE_PATTERNS = [
  /^(participant|actor)\s+\S/,
  /^(create\s+(participant|actor)|destroy)\s+\S/,
  /^box(\s|$)/,
  // A hyphen joins word runs (`Auth-Service`); in the sender never before `x`, so it cannot also read as
  // the `-x` arrow, an ambiguity that backtracks quadratically on a long `A-xA-x...` line with no colon.
  /^[\w.]+(?:-(?!x)[\w.]+)*(?: [\w.]+(?:-(?!x)[\w.]+)*)*\s*(<<-->>|<<->>|-->>|->>|--x|--\)|-->|->|-x|-\))[+-]?\s*[\w.]+(?:-[\w.]+)*(?: [\w.]+(?:-[\w.]+)*)*\s*:/,
  /^Note\s+(left of|right of|over)\s+\S/,
  /^(loop|alt|else|opt|par|and|critical|option|break|rect)(\s|$)/,
  /^(autonumber|activate|deactivate|links?)(\s|$)/,
  /^(title|accTitle|accDescr)\b/,
];

/**
 * Checks if a line contains valid Mermaid syntax. `sequence` also accepts sequence-diagram-only lines.
 */
export function isMermaidSyntax(line: string, sequence = false): boolean {
  // Empty lines are valid
  if (!line.trim()) return true;

  // Common Mermaid syntax patterns
  const mermaidPatterns = [
    // Diagram declarations
    /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|mindmap)\s/,
    // Node definitions and connections
    /^[A-Za-z0-9_]+(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?(\s*-->?\s*|\s*==>\s*|\s*-\.\s*|\s*-\.-\s*)/,
    // Simple node definitions
    /^[A-Za-z0-9_]+(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*$/,
    // Connections with labels
    /^[A-Za-z0-9_]+\s*-*>?\|\w+\|\s*[A-Za-z0-9_]+/,
    // Subgraph definitions
    /^subgraph\s+/,
    /^end\s*$/,
    // Comments
    /^%%/,
    // Class definitions
    /^class\s+/,
    // Style definitions
    /^style\s+/,
    // Direction declarations
    /^direction\s+(TB|BT|LR|RL)$/,
  ];

  // Check against common invalid patterns (likely from LLM mixing content)
  const invalidPatterns = [
    /^```/, // Code block markers
    /^Let me/,
    /^I'll/,
    /^Here's/,
    /^This/, // Common LLM preambles
    /^The above/,
    /^In this/, // LLM explanations
  ];

  // If it matches an invalid pattern, it's not valid Mermaid
  if (invalidPatterns.some(pattern => pattern.test(line))) {
    return false;
  }

  // If it matches a valid Mermaid pattern, it's valid
  return (
    mermaidPatterns.some(pattern => pattern.test(line)) ||
    (sequence && SEQUENCE_PATTERNS.some(pattern => pattern.test(line)))
  );
}
