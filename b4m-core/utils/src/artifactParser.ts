import { Logger } from '@bike4mind/observability';
import { ARTIFACT_ATTRS_PATTERN, ArtifactOperation, ArtifactType, mapMimeTypeToArtifactType } from '@bike4mind/common';

// Built from the shared ARTIFACT_ATTRS_PATTERN so the attribute sub-pattern
// stays in sync with the client parser and PromptReplies truncation detector.
const ARTIFACT_REGEX = new RegExp(`<artifact\\s+(${ARTIFACT_ATTRS_PATTERN})>([\\s\\S]*?)<\\/artifact>`, 'gi');
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
 * `<!--` tokens. MUST STAY IN SYNC with the twin in apps/client/app/utils/artifactParser.ts.
 */
function stripHtmlComments(value: string): string {
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
  let match;

  // Reset lastIndex; ARTIFACT_REGEX is a global regex and retains state between calls.
  ARTIFACT_REGEX.lastIndex = 0;

  while ((match = ARTIFACT_REGEX.exec(content)) !== null) {
    const [fullMatch, attributesString, artifactContent] = match;
    const startIndex = match.index;
    const endIndex = match.index + fullMatch.length;

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

// The next two are duplicated in apps/client/app/utils/artifactParser.ts (hasReactComponentLine
// above is not: the client splits that decision across per-language predicates).
// MUST STAY IN SYNC with that copy.

// A full HTML document: a <!DOCTYPE ...> followed later by a closing </html>.
function hasFullHtmlDocument(code: string): boolean {
  const lower = code.toLowerCase();
  const doctype = lower.indexOf('<!doctype');
  if (doctype < 0) return false;
  return lower.indexOf('</html>', doctype + '<!doctype'.length) >= 0;
}

// A complete SVG: an opening <svg followed later by a closing </svg>.
function hasCompleteSvg(code: string): boolean {
  const lower = code.toLowerCase();
  const open = lower.indexOf('<svg');
  if (open < 0) return false;
  return lower.indexOf('</svg>', open + '<svg'.length) >= 0;
}

/**
 * Post-processes AI responses to detect code blocks that should be artifacts
 * and converts them to proper artifact syntax as a fallback
 */
export function convertCodeBlocksToArtifacts(content: string): string {
  // The fence patterns below put no \s* in front of the body group: it is greedy over
  // characters the lazy body matches anyway, so a fence label followed by a long
  // whitespace run and no closer backtracks quadratically. Every callback trims.
  // Detect React component code blocks (body captured linearly; see hasReactComponentLine)
  const reactCodeBlockRegex = /```(?:tsx?|javascript|jsx)([\s\S]*?)```/gi;

  content = content.replace(reactCodeBlockRegex, (match, codeContent) => {
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

  content = content.replace(htmlCodeBlockRegex, (match, codeContent) => {
    if (!hasFullHtmlDocument(codeContent)) return match;
    const title = extractHTMLTitle(codeContent) || 'HTML Page';
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
  content = content.replace(htmlFragmentFenceRegex, (match, codeContent) => {
    // Require at least one HTML tag so a mislabeled fence of plain text is left alone.
    if (!/<[a-z][a-z0-9]*[\s/>]/i.test(codeContent)) return match;
    const title = extractHTMLTitle(codeContent) || 'HTML Snippet';
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Detect SVG code blocks (body captured linearly; see hasCompleteSvg)
  const svgCodeBlockRegex = /```svg([\s\S]*?)```/gi;

  content = content.replace(svgCodeBlockRegex, (match, codeContent) => {
    // Not a complete <svg>...</svg> - leave the fence unchanged.
    if (!hasCompleteSvg(codeContent)) return match;
    const identifier = 'svg-graphic';

    return `<artifact identifier="${identifier}" type="image/svg+xml" title="SVG Graphic">
${codeContent.trim()}
</artifact>`;
  });

  // Detect Mermaid code blocks and mixed content. The body used to be a repeated
  // (?:.*\n)*? group that the greedy \s* could backtrack into, so an unclosed fence
  // after a long whitespace run cost time quadratic in the run. One lazy group with
  // an explicit non-whitespace first character leaves \s* nothing to give back. The
  // match set is unchanged: (?:.|\n) spans exactly the characters the old body could
  // cross, the body still starts at the first non-whitespace character and still has to
  // end on a newline, and the group is lazily optional so a closer sitting right after
  // the whitespace run still wins over a later one.
  const mermaidCodeBlockRegex = /```mermaid\s*((?:\S(?:.|\n)*?\n)??)```/gi;

  content = content.replace(mermaidCodeBlockRegex, (fullMatch, codeContent) => {
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
    if (fullMatch.includes('```') || fullMatch.includes('<artifact')) {
      return fullMatch;
    }

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

  content = promoteToolCallJsonArtifact(content);

  content = promoteBareHtmlDocument(content);

  return content;
}

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
 * MUST STAY IN SYNC with the twin copy in apps/client/app/utils/artifactParser.ts
 * so client render and server persistence never diverge.
 */
function promoteToolCallJsonArtifact(content: string): string {
  // Fence labels a model uses for a tool call; a ```html fence is handled above.
  // The negative lookahead stops ```tool matching inside ```tool_calls etc.
  const fenceRegex = /```(?:json|tool_code|tool)(?![a-z0-9_])([\s\S]*?)```/gi;
  const afterFences = content.replace(fenceRegex, (match, body) => toolCallJsonToArtifact(body) ?? match);
  if (afterFences !== content) return afterFences;

  // A model may also return the bare object as its entire reply (no fence).
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const artifact = toolCallJsonToArtifact(trimmed);
    if (artifact) return content.replace(trimmed, () => artifact);
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

  const title = extractHTMLTitle(html) || 'HTML Page';
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
function promoteBareHtmlDocument(content: string): string {
  // Two forward cursors instead of one <html>...</html> pattern, and guard counts that
  // accumulate over the gap since the previous document instead of re-reading the whole
  // prefix: both of the old shapes re-scanned from the start of the message on every
  // candidate, so this pass cost time quadratic in the message length.
  // MUST STAY IN SYNC with the twin copy in apps/client/app/utils/artifactParser.ts.
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
    const title = extractHTMLTitle(doc) || 'HTML Page';
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    out += content.slice(copiedTo, start);
    out += `<artifact identifier="${identifier}" type="text/html" title="${title}">
${doc.trim()}
</artifact>`;
    copiedTo = end;
    promoted = true;
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

/**
 * Extracts title from HTML content, minus any double quote. Every caller interpolates
 * the result into title="...", and the artifact attribute parser (ATTRIBUTE_REGEX) has
 * no escape mechanism, so an embedded " in this model-controlled text would truncate
 * the attribute and leave the rest of the title to be read as further attributes.
 * Apostrophes are safe inside a double-quoted value and are kept.
 */
function extractHTMLTitle(code: string): string | null {
  const titleMatch = code.match(/<title>(.*?)<\/title>/i);
  if (!titleMatch) return null;
  return titleMatch[1].replace(/"/g, '') || null;
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
        mermaidLines.push(line);
        continue;
      }
      // Skip non-Mermaid content before diagram starts
      continue;
    }

    // If we've started Mermaid content, check if this line is valid Mermaid
    if (foundMermaidStart && !foundInvalidContent) {
      if (isMermaidSyntax(trimmedLine)) {
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

/**
 * Checks if a line contains valid Mermaid syntax
 */
export function isMermaidSyntax(line: string): boolean {
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
  return mermaidPatterns.some(pattern => pattern.test(line));
}
