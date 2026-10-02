import { Logger } from '@bike4mind/observability';
import { ArtifactOperation, ArtifactType, mapMimeTypeToArtifactType, matchArtifactBlocks } from '@bike4mind/common';

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
 * Parses Claude-style artifact syntax from text content
 *
 * Example syntax:
 * <artifact identifier="todo-app" type="application/vnd.ant.react" title="Todo List App">
 * // React component code here
 * </artifact>
 */
export function parseArtifacts(content: string): ArtifactParseResult {
  const artifacts: ParsedArtifact[] = [];
  let cleanedContent = content;

  for (const block of matchArtifactBlocks(content)) {
    const { index: startIndex, fullMatch, attrs: attributesString, body: artifactContent } = block;
    const endIndex = startIndex + fullMatch.length;

    // Parse attributes
    const attributes: Record<string, string> = {};
    let attrMatch;
    ATTRIBUTE_REGEX.lastIndex = 0;

    while ((attrMatch = ATTRIBUTE_REGEX.exec(attributesString)) !== null) {
      const [, key, doubleQuoted, singleQuoted] = attrMatch;
      attributes[key] = doubleQuoted ?? singleQuoted;
    }

    // Determine artifact type and operation
    const mimeType = attributes.type || '';
    const identifier = attributes.identifier;
    const title = attributes.title || 'Untitled Artifact';
    const language = attributes.language;

    // Map MIME type to our artifact type
    const artifactType = mapMimeTypeToArtifactType(mimeType);

    // Determine operation (create for new, update for existing with same identifier)
    const operation: ArtifactOperation =
      identifier && artifacts.some(a => a.identifier === identifier) ? 'update' : 'create';

    if (artifactType) {
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
  }

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

// The next two are exported for apps/client/app/utils/artifactParser.ts to import
// (hasReactComponentLine above is not shared: the client splits that decision across
// per-language predicates).

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
 * region is never promoted to an artifact, by this parser or by the client mirror in
 * apps/client/app/utils/artifactParser.ts. History replay must strip it before the model
 * sees the reply again.
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

const ARTIFACT_CLOSE_LENGTH = '</artifact>'.length;

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, ' ');

// Single-line only: the body lines of a multi-line `accDescr {` block still count.
const MERMAID_DEDUPE_IGNORED_LINE = /^(?:title|accTitle|accDescr)\b|^%%/;

/** Dedupe form of a mermaid body: title, accessibility and comment lines dropped, whitespace normalized. */
const mermaidDedupeLines = (value: string): string[] =>
  value.split('\n').filter(line => !MERMAID_DEDUPE_IGNORED_LINE.test(line.trim()));
const normalizeMermaid = (value: string): string => normalizeWhitespace(mermaidDedupeLines(value).join('\n'));

/**
 * Protects every complete artifact span from the detectors and collects normalized mermaid bodies,
 * plus each body's first line (the raw pass matches only that). A span wrapping a tool-output
 * placeholder is not protected itself, but artifacts inside it still are.
 */
function protectArtifactSpans(content: string, mask: ToolOutputMask): { masked: string; mermaidBodies: Set<string> } {
  const mermaidBodies = new Set<string>();
  const spans: Array<[number, number]> = [];
  // A held block is skipped by rescanning from its body, so an inner artifact sharing its closer is still found.
  for (let pos = 0, again = true; again;) {
    again = false;
    for (const block of matchArtifactBlocks(content.slice(pos))) {
      const start = pos + block.index;
      const type = Array.from(block.attrs.matchAll(ATTRIBUTE_REGEX))
        .filter(m => m[1] === 'type')
        .pop();
      if ((type?.[2] ?? type?.[3]) === 'application/vnd.ant.mermaid') {
        const lines = mermaidDedupeLines(block.body.trim());
        mermaidBodies.add(normalizeMermaid(block.body));
        mermaidBodies.add(normalizeWhitespace(lines[0] ?? ''));
      }
      // restore() is single-pass, so a span wrapping an already-protected region cannot itself be protected.
      if (mask.holds(block.fullMatch)) {
        pos = start + block.fullMatch.length - ARTIFACT_CLOSE_LENGTH - block.body.length;
        again = true;
        break;
      }
      spans.push([start, start + block.fullMatch.length]);
    }
  }

  let masked = '';
  let copiedTo = 0;
  for (const [start, end] of spans) {
    masked += content.slice(copiedTo, start) + mask.protect(content.slice(start, end));
    copiedTo = end;
  }
  return { masked: masked + content.slice(copiedTo), mermaidBodies };
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
  // Detect React component code blocks (body captured linearly; see hasReactComponentLine)
  const reactCodeBlockRegex = /```(?:tsx?|javascript|jsx)([\s\S]*?)```/gi;

  content = content.replace(reactCodeBlockRegex, (match, codeContent) => {
    if (echoOnly || holds(codeContent)) return match;
    // Anchor requirement the old regex encoded inline: a declaration + component token
    // on one line. Without it, this fence is not a React component - leave it alone.
    if (!hasReactComponentLine(codeContent)) return match;
    // Check if this looks like a React component
    if (
      codeContent.includes('useState') ||
      codeContent.includes('useEffect') ||
      codeContent.includes('export default') ||
      (codeContent.includes('function') && codeContent.includes('return'))
    ) {
      // Generate a simple identifier from the content
      const componentName = extractComponentName(codeContent) || 'component';
      const identifier = componentName.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${componentName}">
${codeContent.trim()}
</artifact>`;
    }
    return match;
  });

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
      // If validation fails, keep the original content and log errors
      Logger.globalInstance.warn('Mermaid validation failed:', errors);
      return fullMatch;
    }
  });

  // Also handle raw Mermaid content (no code blocks) mixed with other content,
  // e.g. when an LLM outputs raw Mermaid plus code blocks.
  const rawMermaidRegex =
    /((?:^|\n)(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|mindmap)[\s\S]*?)(?=\n```|$)/gm;

  content = content.replace(rawMermaidRegex, (fullMatch, mermaidContent) => {
    // Skip if this is already inside a code block or artifact
    if (echoOnly || holds(fullMatch) || fullMatch.includes('```') || fullMatch.includes('<artifact')) {
      return fullMatch;
    }

    if (isDuplicateMermaid(mermaidContent)) return fullMatch;
    const { isValid, cleanedContent } = validateMermaidSyntax(mermaidContent);

    if (isValid && cleanedContent.trim()) {
      const diagramType = extractMermaidDiagramType(cleanedContent);
      const identifier = `mermaid-${diagramType}`;
      const title = `${diagramType.charAt(0).toUpperCase() + diagramType.slice(1)} Diagram`;

      return `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">${cleanedContent}</artifact>`;
    } else {
      // If validation fails, return original content
      return fullMatch;
    }
  });

  content = promoteToolCallJsonArtifact(content, echoFence, echoOnly, holds);

  content = promoteBareHtmlDocument(content, echoFence, echoOnly, holds);

  return mask.restore(content);
}

/** Returns the protected marked fence when the span is a tool echo, else null. */
type EchoFence = (lang: string, body: string, whole: string, start: number, end: number) => string | null;

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
 *
 * Recognition must stay identical to the twin in apps/client/app/utils/artifactParser.ts.
 * Only this copy marks tool echoes; the client never sees tool output and relies on the
 * fences marked here.
 */
function promoteToolCallJsonArtifact(
  content: string,
  echoFence: EchoFence,
  echoOnly: boolean,
  holds: (value: string) => boolean
): string {
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
function promoteBareHtmlDocument(
  content: string,
  echoFence: EchoFence,
  echoOnly: boolean,
  holds: (value: string) => boolean
): string {
  // Two forward cursors instead of one <html>...</html> pattern, and guard counts that
  // accumulate over the gap since the previous document instead of re-reading the whole
  // prefix: both of the old shapes re-scanned from the start of the message on every
  // candidate, so this pass cost time quadratic in the message length.
  // Detection must stay identical to the twin in apps/client/app/utils/artifactParser.ts;
  // only this copy marks tool echoes.
  const openRegex = /<!DOCTYPE\s+html|<html/gi;
  const closeRegex = /<\/html\s*>/gi;
  let out = '';
  let copiedTo = 0;
  let promoted = false;
  let scannedTo = 0;
  let fences = 0;
  let artifactOpens = 0;
  let artifactCloses = 0;
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
    artifactOpens += (gap.match(/<artifact\b/gi) || []).length;
    artifactCloses += (gap.match(/<\/artifact>/gi) || []).length;
    scannedTo = start;

    // Skip a document sitting inside a code fence (odd number of ``` before it) or
    // inside an already-open <artifact> tag.
    if (fences % 2 === 1 || artifactOpens > artifactCloses) continue;

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
function extractComponentName(code: string): string | null {
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
function sanitizeHTMLTitle(raw: string | null, fallback: string): string {
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
  /^[\w.]+(?: [\w.]+)*\s*(<<-->>|<<->>|-->>|->>|--x|--\)|-->|->|-x|-\))[+-]?\s*[\w.]+(?: [\w.]+)*\s*:/,
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
