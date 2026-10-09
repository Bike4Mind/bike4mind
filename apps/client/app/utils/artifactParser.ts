import { ArtifactPayload, ArtifactType, scanArtifactOpenTag } from '@bike4mind/common';
import { detectElidedContent } from '@bike4mind/utils/artifactElision';
import {
  type ArtifactParseResult,
  type ParsedArtifact,
  extractArtifactBlocks,
  extractComponentName,
  extractHTMLTitle,
  hasCompleteSvg,
  hasFullHtmlDocument,
  isSvgGraphicallyEmpty,
  maskToolOutputRegions,
  promoteBareHtmlDocument,
  promoteToolCallJsonArtifact,
  sanitizeHTMLTitle,
} from '@bike4mind/utils/artifactParser';
import { tryParseChartJSON } from './chartJsonParser';
import { hasSingleLineImportFrom, scanImportStatements } from './importStatements';
import {
  ResultReplacer,
  replaceDirectTypeObjects,
  replaceEscapedResultObjects,
  replaceLazyResultObjects,
  replaceLogFormatResultObjects,
} from './toolOutputResultScan';

// Block extraction, the shared types and the shared promoters live in core; this module keeps
// the render-specific stripping and the client-only convert passes.
export type { ArtifactParseResult, ParsedArtifact };
export { isSvgGraphicallyEmpty };

/**
 * Parses Claude-style artifact syntax from text content
 *
 * Example syntax:
 * <artifact identifier="todo-app" type="application/vnd.ant.react" title="Todo List App">
 * // React component code here
 * </artifact>
 */
export function parseArtifacts(
  content: string,
  options?: { rechartsDisplayMode?: 'inline' | 'artifact' }
): ArtifactParseResult {
  // Unlike the server's parseArtifacts, an untyped or unknown-type block still renders: it
  // resolves through its `language` attribute, then falls back to 'code'.
  const artifacts = extractArtifactBlocks(content, { typeFallback: 'language-then-code' });
  let cleanedContent = content;

  // Remove artifact tags from content (in reverse order to maintain indices)
  // For recharts, handle based on display mode preference
  const rechartsDisplayMode = options?.rechartsDisplayMode || 'inline';

  artifacts
    .sort((a, b) => b.startIndex - a.startIndex)
    .forEach(artifact => {
      if (artifact.type === 'chess') {
        // Chess artifacts are rendered as top-level components, strip the tag from content
        cleanedContent = cleanedContent.slice(0, artifact.startIndex) + cleanedContent.slice(artifact.endIndex);
        return;
      }
      if (artifact.type === 'recharts') {
        if (rechartsDisplayMode === 'inline') {
          // Extract the actual chart config using robust JSON parser
          // Handles LLM output issues: trailing text, truncation, single quotes, etc.
          const chartConfig = tryParseChartJSON(artifact.content);

          if (chartConfig) {
            // Successfully parsed - create inline code block
            // Surround with newlines so adjacent code blocks don't merge into ``````
            // CommonMark requires fenced code blocks to start/end on their own line
            const inlineBlock = `\n\`\`\`recharts\n${JSON.stringify(chartConfig, null, 2)}\n\`\`\`\n`;
            cleanedContent =
              cleanedContent.slice(0, artifact.startIndex) + inlineBlock + cleanedContent.slice(artifact.endIndex);
          } else {
            // Parsing failed - fallback to original content for debugging
            console.warn('Failed to parse recharts artifact, falling back to original content');
            const inlineBlock = `\n\`\`\`recharts\n${artifact.content}\n\`\`\`\n`;
            cleanedContent =
              cleanedContent.slice(0, artifact.startIndex) + inlineBlock + cleanedContent.slice(artifact.endIndex);
          }
        } else {
          // Keep as artifact - just remove the tag from cleaned content
          cleanedContent = cleanedContent.slice(0, artifact.startIndex) + cleanedContent.slice(artifact.endIndex);
        }
      } else if (artifact.type === 'svg') {
        // Keep SVG artifacts inline as well - they're handled by the artifacts section
        cleanedContent = cleanedContent.slice(0, artifact.startIndex) + cleanedContent.slice(artifact.endIndex);
      } else {
        // Remove other artifacts normally
        cleanedContent = cleanedContent.slice(0, artifact.startIndex) + cleanedContent.slice(artifact.endIndex);
      }
    });

  // Filter out recharts from artifacts array only if they're being displayed inline
  // Keep SVG artifacts for rendering in the artifacts section
  const filteredArtifacts = artifacts.filter(artifact => {
    if (artifact.type === 'recharts') {
      // Only filter out if displaying inline, keep if displaying as artifact
      return rechartsDisplayMode === 'artifact';
    }
    // Drop graphically-empty SVG placeholders (a small model's `<svg><!-- goes
    // here --></svg>` stub). The tag was already stripped from cleanedContent
    // above, so nothing leaks into the reply - it just never becomes an artifact.
    if (artifact.type === 'svg' && isSvgGraphicallyEmpty(artifact.content)) {
      return false;
    }
    // Keep all other artifact types
    return true;
  });

  return {
    artifacts: filteredArtifacts,
    cleanedContent: cleanedContent.trim(),
  };
}

/**
 * parseArtifacts, then run the code-block/HTML fallback promotion on the LEFTOVER content
 * and merge any newly-promoted artifacts in. parseArtifacts strips the tags it parses, so
 * re-parsing the converted content alone would drop the original set - hence the merge.
 * This lets a mixed reply (an explicit <artifact> plus a bare/fenced HTML document, e.g. an
 * "article") surface both. When nothing was parsed first, cleanedContent is the full input,
 * so this is equivalent to convert-then-parse on the raw content.
 *
 * Shared by the render path (PromptReplies) and the persistence path
 * (useStreamingArtifactPersistence) so both agree on what a reply contains.
 */
export function parseArtifactsWithFallback(
  content: string,
  options?: { rechartsDisplayMode?: 'inline' | 'artifact' }
): ArtifactParseResult {
  const parseResult = parseArtifacts(content, options);
  // ?? (not ||): cleanedContent is always a string, but when every byte of the
  // input was inside artifact tags it is "" -- || would fall back to the original
  // content and re-convert fenced code blocks that live inside those tags.
  const contentForConversion = parseResult.cleanedContent ?? content;
  const convertedContent = convertCodeBlocksToArtifacts(contentForConversion);
  if (convertedContent === contentForConversion) {
    return parseResult;
  }
  const converted = parseArtifacts(convertedContent, options);
  return {
    artifacts: [...parseResult.artifacts, ...converted.artifacts],
    cleanedContent: converted.cleanedContent,
  };
}

/**
 * Creates artifact payload from parsed artifact data
 */
export function createArtifactPayload(parsedArtifact: ParsedArtifact): ArtifactPayload {
  return {
    operation: parsedArtifact.operation,
    artifactId: parsedArtifact.identifier,
    type: parsedArtifact.type,
    title: parsedArtifact.title,
    content: parsedArtifact.content,
    metadata: {
      language: parsedArtifact.language,
      ...(parsedArtifact.type === 'react' && {
        dependencies: extractReactDependencies(parsedArtifact.content),
        hasDefaultExport: checkHasDefaultExport(parsedArtifact.content),
        errorBoundary: true,
      }),
      ...(parsedArtifact.type === 'html' && {
        sanitized: true,
        // Vestigial - no longer gates script execution (the iframe sandbox + route
        // CSP do). Retained to match the persisted HtmlArtifact zod schema;
        // removing the schema field is a separate follow-up.
        allowedScripts: [],
      }),
      ...(parsedArtifact.type === 'svg' && {
        sanitized: true,
      }),
      ...(parsedArtifact.type === 'python' && {
        packages: extractPythonPackages(parsedArtifact.content),
        hasOutput: false,
      }),
    },
  };
}

/**
 * Extracts Python packages from import statements
 */
export function extractPythonPackages(content: string): string[] {
  const packages: Set<string> = new Set();
  const supportedPackages = ['numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn', 'scikit-learn'];

  // Match import statements
  const importPatterns = [/^import\s+(\w+)/gm, /^from\s+(\w+)\s+import/gm];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const pkg = match[1];
      if (supportedPackages.includes(pkg)) {
        packages.add(pkg);
      }
    }
  }

  return Array.from(packages);
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
 * Extracts React dependencies from import statements
 * Also detects commonly used libraries even if import statement is missing
 */
export function extractReactDependencies(content: string): string[] {
  const dependencies: Set<string> = new Set();

  // The clause crosses newlines so multi-line named imports still resolve, e.g.
  // `import {\n  A, B\n} from 'recharts'`.
  for (const { specifier } of scanImportStatements(content)) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      dependencies.add(specifier);
    }
  }

  // Auto-detect lucide-react usage only if this appears to be React code
  // Check for React indicators first to avoid false positives on plain JS classes
  const hasReactIndicators =
    content.includes('React') ||
    content.includes('useState') ||
    content.includes('useEffect') ||
    content.includes('jsx') ||
    content.includes('tsx') ||
    content.includes('return (') ||
    content.includes('return(') ||
    /<[A-Z]/.test(content); // JSX component usage

  if (hasReactIndicators) {
    // Look for common Lucide icon patterns (PascalCase with typical icon names)
    const lucideIconPatterns = [
      /\b(Menu|X|ChevronDown|ChevronUp|ChevronLeft|ChevronRight|Check|Plus|Minus|Search|Settings|User|Home|Mail|Phone|Calendar|Clock|Star|Heart|Eye|Edit|Trash|Download|Upload|Share|Copy|Clipboard|Link|ExternalLink|Image|File|Folder|Lock|Unlock|Key|Shield|Bell|AlertCircle|AlertTriangle|Info|HelpCircle|Sun|Moon|Zap|Battery|Wifi|Cloud|Database|Server|Code|Terminal|Package|Box|Archive|Bookmark|Tag|Filter|Sort|Grid|List|BarChart|PieChart|LineChart|TrendingUp|TrendingDown|Activity|Layers|Layout|Maximize|Minimize|Move|RotateCw|RotateCcw|RefreshCw|ZoomIn|ZoomOut|Volume|Play|Pause|SkipBack|SkipForward|Repeat|Shuffle|Music|Video|Camera|Mic|Speaker|Headphones|Award|Gift|Trophy|Target|Flag|Map|MapPin|Navigation|Compass|Send|MessageCircle|MessageSquare|MessageSquare|Paperclip|AtSign|Hash|DollarSign|Percent|ShoppingCart|ShoppingBag|CreditCard|Briefcase|Building|Users|UserPlus|UserMinus|UserCheck|LogIn|LogOut|Power|Trash2|Archive|Save|Download|Upload|FileText|FileImage|FilePlus|FolderPlus|MoreVertical|MoreHorizontal|Circle|Square|Triangle|Hexagon|Octagon|Crosshair|Aperture|Feather|GitBranch|GitCommit|GitMerge|GitPullRequest|Github|Gitlab|Figma|Slack|Twitter|Facebook|Instagram|Linkedin|Youtube|Chrome|Firefox|Package|Coffee|Smile|ThumbsUp|ThumbsDown)\b/g,
    ];

    // Check if any Lucide icon patterns are used in the code
    for (const pattern of lucideIconPatterns) {
      if (pattern.test(content)) {
        dependencies.add('lucide-react');
        break;
      }
    }
  }

  return Array.from(dependencies);
}

/**
 * Checks if React component has a default export
 */
export function checkHasDefaultExport(content: string): boolean {
  return /export\s+default\s+/i.test(content) || /export\s*{\s*[A-Za-z_$][\w$]*\s+as\s+default\s*}/i.test(content);
}

/**
 * Validates that artifact content is safe and follows expected patterns
 */
export function validateArtifactContent(
  type: ArtifactType,
  content: string
): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Basic content validation
  if (!content.trim()) {
    errors.push('Artifact content cannot be empty');
  }

  // Type-specific validation
  switch (type) {
    case 'react':
      if (!content.includes('export default')) {
        errors.push('React components must have a default export');
      }
      break;
    case 'html': {
      // Case-insensitive: `<!doctype html>` is valid HTML and is what several models emit,
      // but the old exact-case check rejected it as malformed.
      const lowered = content.toLowerCase();
      if (!lowered.includes('<html') && !lowered.includes('<!doctype')) {
        errors.push('HTML artifacts should include proper HTML structure');
      }
      break;
    }
    case 'svg':
      if (!content.includes('<svg')) {
        errors.push('SVG artifacts must contain SVG elements');
      }
      break;
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
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
 * Detects tool outputs (JSON responses from tools) and converts them to artifact syntax
 */
function convertToolOutputsToArtifacts(content: string, holds: (value: string) => boolean): string {
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
    processedContent = step(processedContent, (match, captured) => {
      if (holds(match)) return match;
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
          console.warn('Error during string unescaping, using original:', unescapeError);
          jsonString = captured || match; // Fallback to original
        }

        const toolOutput = JSON.parse(jsonString);

        if ((toolOutput.type === 'rechart' || toolOutput.type === 'recharts') && toolOutput.content) {
          const identifier = `recharts-${Date.now()}`;
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
              console.warn('Invalid recharts config: missing chartType or data');
              return match; // Return original if validation fails
            }

            const rechartsBody =
              typeof toolOutput.content === 'string' ? toolOutput.content : JSON.stringify(toolOutput.content);

            return `<artifact identifier="${identifier}" type="application/vnd.ant.recharts" title="${title}">
${escapeArtifactBodyJson(rechartsBody)}
</artifact>`;
          } catch (validationError) {
            console.warn('Failed to validate recharts content:', validationError);
            return match; // Return original if validation fails
          }
        }

        if (toolOutput.type === 'mermaid' && toolOutput.content) {
          const identifier = `mermaid-${Date.now()}`;
          const title = sanitizeToolOutputTitle(toolOutput.metadata?.title || 'Mermaid Diagram') || 'Mermaid Diagram';

          const artifactSyntax = `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">
${stripArtifactTagsFromRawBody(String(toolOutput.content))}
</artifact>`;

          return artifactSyntax;
        }
      } catch (error) {
        console.warn('Failed to parse tool output JSON:', error instanceof Error ? error.message : error);
        console.warn('Problematic string:', (captured || match)?.substring(0, 100));
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
 * Post-processes AI responses to detect code blocks that should be artifacts
 * and converts them to proper artifact syntax as a fallback
 */
export function convertCodeBlocksToArtifacts(content: string): string {
  // Fences the server marked as quoted tool output stay text; detection itself is server-only
  // (b4m-core/utils artifactParser).
  // A span holding a placeholder is never promoted: restore would put the marked output
  // back inside the artifact.
  const mask = maskToolOutputRegions(content);
  content = mask.masked;
  const { holds } = mask;

  // First, detect tool outputs that should become artifacts
  content = convertToolOutputsToArtifacts(content, holds);

  // Then process code blocks
  // The fence patterns below put no \s* in front of the body group: it is greedy over
  // characters the lazy body matches anyway, so a fence label followed by a long
  // whitespace run and no closer backtracks quadratically. Every callback trims. (There is
  // no mermaid fence here; core has one, and its match set depends on the \s* skip between
  // label and body, so core walks that fence by index instead of dropping the \s*.)
  // Detect React component code blocks - use stricter matching
  // Match tsx/jsx explicitly, or javascript/typescript with React patterns
  const reactCodeBlockRegex = /```(tsx?|jsx|javascript|typescript)([\s\S]*?)```/gi;

  content = content.replace(reactCodeBlockRegex, (match, language, codeContent) => {
    if (holds(codeContent)) return match;
    // For tsx/jsx, always treat as React
    if (language === 'tsx' || language === 'jsx') {
      const componentName = extractComponentName(codeContent) || 'component';
      const identifier = componentName.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${componentName}">
${codeContent.trim()}
</artifact>`;
    }

    // For javascript/typescript, require strong React indicators
    // Count React-specific patterns (need at least 2 to convert), over a capped prefix so
    // five predicates cannot each rescan a large fence body. A closed fence whose only
    // indicators sit past the window is left a plain code block.
    const scanContent = codeContent.slice(0, MAX_FENCE_SCAN_CHARS);
    const hasReactHooks =
      /\buse(State|Effect|Context|Reducer|Callback|Memo|Ref|ImperativeHandle|LayoutEffect|DebugValue)\b/.test(
        scanContent
      );
    const hasJSXSyntax = /<[A-Z][a-zA-Z0-9]*[\s\/>]/.test(scanContent) || hasSelfClosingTag(scanContent);
    const hasReactImport = hasSingleLineImportFrom(scanContent, 'react');
    const hasReactComponent = /extends\s+(?:React\.)?Component\b/.test(scanContent);
    const hasJSXReturn = /return\s*\(\s*</.test(scanContent);

    // Count how many React indicators we found
    const reactIndicatorCount = [hasReactHooks, hasJSXSyntax, hasReactImport, hasReactComponent, hasJSXReturn].filter(
      Boolean
    ).length;

    // Require at least 2 strong React indicators to treat as React component
    if (reactIndicatorCount >= 2) {
      const componentName = extractComponentName(codeContent) || 'component';
      const identifier = componentName.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${componentName}">
${codeContent.trim()}
</artifact>`;
    }

    // Not enough React indicators - keep as regular code block
    return match;
  });

  // Detect HTML code blocks. The fence is matched on its own and the document
  // anchors are checked in the callback. With <!DOCTYPE and </html> anchored inside
  // the pattern, two lazy multi-line groups had to split the body between them, so a
  // fence that never closed and repeated </html> cost time quadratic in body size.
  // The two-tier split is the original behavior; what changed is that two adjacent `html`
  // fences are now two artifacts, where the old regex merged them into one. A body carrying
  // a CR, U+2028 or U+2029 is also accepted now, where the old `.`/`\n`-built pattern could
  // not reach across one - the html fence in core's convertCodeBlocksToArtifacts uses the
  // same [\s\S] body class, so client and core agree on which bodies promote.
  const htmlCodeBlockRegex = /```html([\s\S]*?)```/gi;

  content = content.replace(htmlCodeBlockRegex, (match, codeContent) => {
    if (!hasFullHtmlDocument(codeContent) || holds(codeContent)) return match;
    const title = sanitizeHTMLTitle(extractHTMLTitle(codeContent), 'HTML Page');
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Promote ```html fences that lack a full <!DOCTYPE>...</html> document (HTML
  // fragments). The DOCTYPE-requiring regex above already converted full documents,
  // so any remaining ```html fence is a fragment - still better presented as a
  // previewable artifact than left as a raw code block.
  const htmlFragmentFenceRegex = /```html([\s\S]*?)```/gi;
  content = content.replace(htmlFragmentFenceRegex, (match, codeContent) => {
    // Require at least one HTML tag so a mislabeled fence of plain text is left alone.
    if (!/<[a-z][a-z0-9]*[\s/>]/i.test(codeContent) || holds(codeContent)) return match;
    const title = sanitizeHTMLTitle(extractHTMLTitle(codeContent), 'HTML Snippet');
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Detect SVG code blocks. Same shape as the HTML pass above: match the fence,
  // then check for a complete <svg> element in the callback. Same accepted widening: a body
  // carrying a CR, U+2028 or U+2029 is promoted here where the old `.`/`\n`-built pattern left
  // it a code block, and there is no svg fragment pass behind this one to catch it.
  const svgCodeBlockRegex = /```svg([\s\S]*?)```/gi;

  content = content.replace(svgCodeBlockRegex, (match, codeContent) => {
    // Not a complete <svg>...</svg> - leave the fence unchanged.
    if (!hasCompleteSvg(codeContent) || holds(codeContent)) return match;
    const identifier = 'svg-graphic';

    return `<artifact identifier="${identifier}" type="image/svg+xml" title="SVG Graphic">
${codeContent.trim()}
</artifact>`;
  });

  // Detect Python code blocks - convert substantial Python code to Python artifacts
  const pythonCodeBlockRegex = /```(?:python|py)([\s\S]*?)```/gi;

  content = content.replace(pythonCodeBlockRegex, (match, codeContent) => {
    if (holds(codeContent)) return match;
    const trimmedCode = codeContent.trim();

    // Only convert if it's substantial code (more than a simple one-liner)
    // This helps avoid converting simple inline examples
    const lineCount = trimmedCode.split('\n').length;
    const hasImports = /^(?:import|from)\s+\w+/m.test(trimmedCode);
    const hasDefinitions = /^(?:def|class)\s+\w+/m.test(trimmedCode);
    const hasPrint = /print\s*\(/.test(trimmedCode);
    const hasSubstantialCode = lineCount >= 3 || hasImports || hasDefinitions;

    // Convert to Python artifact if it looks like runnable code
    if (hasSubstantialCode || (hasPrint && lineCount >= 2)) {
      const title = extractPythonTitle(trimmedCode) || 'Python Script';
      const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.python" title="${title}">
${trimmedCode}
</artifact>`;
    }

    // Keep simple examples as regular code blocks
    return match;
  });

  const markdownBlockRegex = /```markdown([\s\S]*)```/gi;
  content = content.replace(markdownBlockRegex, (_match, codeContent) => {
    const updatedContent = codeContent.replace(/```/g, '~~~');
    return `\`\`\`markdown${updatedContent}\`\`\``;
  });

  content = promoteToolCallJsonArtifact(content, holds);

  content = promoteBareHtmlDocument(content, holds);

  return mask.restore(content);
}

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

/**
 * Generate a complete artifact ID with timestamp and index
 * This matches the format used by persistence in useSubscribeChatCompletion
 * Format: artifact_{type}_{identifier}_{timestamp}_{index}
 */
// Shared timestamp cache to ensure same timestamp is used across all artifact ID generation
// Key: quest ID or message ID
const artifactTimestampCache = new Map<string, number>();

/**
 * Get or generate a timestamp for a specific quest/message
 * This ensures all artifacts in the same quest use the same timestamp
 */
export function getArtifactTimestamp(questOrMessageId: string): number {
  if (!artifactTimestampCache.has(questOrMessageId)) {
    const timestamp = Date.now();
    artifactTimestampCache.set(questOrMessageId, timestamp);
  }
  return artifactTimestampCache.get(questOrMessageId)!;
}

export function generateCompleteArtifactId(type: string, identifier: string, timestamp: number, index: number): string {
  const baseId = identifier || `generated_${timestamp}`;
  return `artifact_${type}_${baseId}_${timestamp}_${index}`;
}

/**
 * Returns true when `tail` (the substring from `<artifact` onward) contains
 * a complete opening tag (i.e. the closing `>` arrived before the stream was
 * cut). Used by repairTruncatedArtifact (./replyTruncation) to decide
 * whether to best-effort close the tag or drop the partial.
 */
export function hasCompleteOpeningTag(tail: string): boolean {
  return tail.startsWith('<artifact') && scanArtifactOpenTag(tail, 0, 'run') !== null;
}

/**
 * Whether to show the "may be incomplete" notice for a reply. Companion to the truncation
 * check above and deliberately subordinate to it: a truncated reply already gets a more
 * accurate banner, so this stays quiet rather than stacking two warnings on one artifact.
 *
 * `suspectedElision` is the server's verdict (stamped in ChatCompletionProcess); the local
 * scan is the fallback for replies generated before that shipped and for backends that
 * persist no promptMeta. Advisory only - the caller must still render the artifact as-is.
 */
/**
 * `detectElidedContent` behind a catch, for symmetry with the server call sites, which are all
 * wrapped. The detector is advisory, so a throw must never cost the user something real - and the
 * render path is the dangerous one, since a throw inside a render memo would unmount the reply
 * container over a warning that was never load-bearing. Fails OPEN: no warning beats no reply.
 *
 * Lives CLIENT-side rather than next to the detector in `@bike4mind/utils` on purpose: it reports
 * through `console.warn`, which is this file's convention for a degraded path but wrong on the Lambda,
 * where the server call sites wrap their own calls with `logger.warn` instead. Shared code would have
 * to pick one. `publishApi` imports it from here for that reason.
 */
export function detectElidedSafe(content: string, type?: ArtifactType): boolean {
  try {
    return detectElidedContent(content, type).elided;
  } catch (error) {
    // Logged rather than swallowed silently: the server call sites log their failures, and a detector
    // that starts throwing in the browser would otherwise look exactly like a detector that finds
    // nothing. Matches the console.warn convention used elsewhere in this file for degraded paths.
    console.warn('Elision detection failed; treating artifact as complete:', error);
    return false;
  }
}

export function shouldWarnElidedArtifact(input: {
  completed: boolean;
  isTruncatedArtifact: boolean;
  suspectedElision: boolean;
  artifacts: Array<{ content: string; type: ArtifactType }>;
}): boolean {
  if (!input.completed || input.isTruncatedArtifact) return false;
  if (input.suspectedElision) return true;
  return input.artifacts.some(a => detectElidedSafe(a.content, a.type));
}

/**
 * Whether sharing a whole REPLY should warn that it may be incomplete.
 *
 * Separate from `shouldWarnElidedArtifact` because the inputs differ: the reply-share surface has no
 * parsed artifact list and no artifact type, only the raw markdown it is about to snapshot. Publishing
 * a reply persists that markdown INCLUDING any `<artifact>` body, so this surface can put an elided
 * artifact behind a public link just as the artifact surfaces can.
 *
 * Prefers the server verdict; falls back to scanning the markdown. The fallback is weaker on purpose
 * and not a bug: with no type to gate on, the JS-bearing scans (undefined references, hollow bodies)
 * do not run, so only the placeholder-comment signal applies. That is the loudest, highest-confidence
 * signal, and a missed warning here leaves the surface exactly as it was before this existed.
 *
 * Note this is NOT subordinate to truncation the way the chat banner is: there is no truncation
 * affordance in the share dialog to defer to, so suppressing here would just lose the warning.
 */
export function elidedReplyWarning(
  promptMeta: { suspectedElision?: unknown } | null | undefined,
  markdown: string | undefined
): boolean {
  if (promptMeta?.suspectedElision) return true;
  if (!markdown) return false;
  return detectElidedSafe(markdown);
}

// Re-export validation functions from the core utils package
export { validateMermaidSyntax } from '@bike4mind/utils/artifactParser';
