import {
  ARTIFACT_ATTRS_PATTERN,
  ArtifactPayload,
  ArtifactOperation,
  ArtifactType,
  mapMimeTypeToArtifactType,
} from '@bike4mind/common';
import { tryParseChartJSON } from './chartJsonParser';

// Built from the shared ARTIFACT_ATTRS_PATTERN so the attribute sub-pattern
// stays in sync with the core parser and PromptReplies truncation detector.
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
 * A "graphically empty" SVG has no drawable content - only the root <svg> wrapper
 * around whitespace and/or comments. Small local models sometimes emit such a stub
 * as a placeholder (e.g. `<svg ...><!-- fish illustration goes here --></svg>`),
 * which would otherwise render/persist as a blank canvas. Deliberately conservative:
 * only whitespace/comments count as empty, so it never drops an SVG with a real
 * element (it does miss rarer stubs like an empty `<g></g>`, which is acceptable).
 * Exported for tests.
 */
export function isSvgGraphicallyEmpty(svg: string): boolean {
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, '');
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
export function parseArtifacts(
  content: string,
  options?: { rechartsDisplayMode?: 'inline' | 'artifact' }
): ArtifactParseResult {
  const artifacts: ParsedArtifact[] = [];
  let cleanedContent = content;
  let match;

  // Reset regex lastIndex to ensure we start from the beginning
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

    // Map MIME type to our artifact type, with language fallback
    let artifactType = mapMimeTypeToArtifactType(mimeType);

    // If MIME type mapping failed, try language attribute fallback
    if (!artifactType && language) {
      artifactType = mapLanguageToArtifactType(language);
      if (artifactType) {
        console.info(`[ArtifactParser] Used language fallback: "${language}" → "${artifactType}"`);
      }
    }

    // If still no type found, fallback to generic 'code' artifact to prevent content loss
    if (!artifactType) {
      artifactType = 'code';
      console.info(
        `[ArtifactParser] No type or language specified, defaulting to 'code' artifact: type="${mimeType}", language="${language}"`
      );
    }

    // Determine operation (create for new, update for existing with same identifier)
    const operation: ArtifactOperation =
      identifier && artifacts.some(a => a.identifier === identifier) ? 'update' : 'create';

    artifacts.push({
      fullMatch,
      identifier,
      type: artifactType,
      language: language || 'text',
      title,
      content: artifactContent.trim(),
      operation,
      startIndex,
      endIndex,
    });
  }

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

// mapMimeTypeToArtifactType is the single source of truth in @bike4mind/common.

/**
 * Maps language attribute to artifact type
 * Used as a fallback when MIME type mapping returns null
 * Supports common language identifiers from various AI providers
 */
function mapLanguageToArtifactType(language: string): ArtifactType | null {
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
  const supportedPackages = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'sklearn', 'scikit-learn'];

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
 * Extracts React dependencies from import statements
 * Also detects commonly used libraries even if import statement is missing
 */
export function extractReactDependencies(content: string): string[] {
  const dependencies: Set<string> = new Set();

  // Match import statements
  // [\s\S]*? (not .*?) so the import clause can span newlines for multi-line
  // named imports, e.g. `import {\n  A, B\n} from 'recharts'`
  const importRegex = /import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const dependency = match[1];
    if (!dependency.startsWith('.') && !dependency.startsWith('/')) {
      dependencies.add(dependency);
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
    case 'html':
      if (!content.includes('<html') && !content.includes('<!DOCTYPE')) {
        errors.push('HTML artifacts should include proper HTML structure');
      }
      break;
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
 * Detects tool outputs (JSON responses from tools) and converts them to artifact syntax
 */
function convertToolOutputsToArtifacts(content: string): string {
  // Look for any JSON-like structure that contains type field with our target types
  // This approach is more forgiving of escaping variations
  const typePattern = /(?:rechart|recharts|mermaid)/g;
  const hasTargetType = typePattern.test(content);

  if (!hasTargetType) {
    return content;
  }

  // Try to find and extract JSON objects that contain our artifact types
  // We'll look for various patterns of escaping around the "result" field
  const patterns = [
    // Pattern 1: Standard result field with escaped JSON (most common from logs)
    /"result":\s*"(\{\\?"[^"]*\\?":\s*\\?"[^"]*\\?"[^}]*\})"/g,
    // Pattern 2: Result field with simpler escaping
    /"result":\s*"(\{[^"]*(?:\\"[^"]*)*\})"/g,
    // Pattern 3: More permissive result field matching
    /"result":\s*"(\{.*?\})"/g,
    // Pattern 4: Direct JSON object (less common but possible)
    /(\{[^{}]*"type"\s*:\s*"(?:rechart|recharts|mermaid)"[^{}]*\})/g,
    // Pattern 5: Very specific pattern for the exact log format
    /"result":\s*"\{(\\\\"type\\\\":\\\\"(?:rechart|recharts|mermaid)\\\\"[^}]*)\}"/g,
  ];

  let processedContent = content;

  for (const pattern of patterns) {
    processedContent = processedContent.replace(pattern, (match, captured) => {
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
          const title = toolOutput.metadata?.title || 'Interactive Chart';

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

            return `<artifact identifier="${identifier}" type="application/vnd.ant.recharts" title="${title}">
${typeof toolOutput.content === 'string' ? toolOutput.content : JSON.stringify(toolOutput.content)}
</artifact>`;
          } catch (validationError) {
            console.warn('Failed to validate recharts content:', validationError);
            return match; // Return original if validation fails
          }
        }

        if (toolOutput.type === 'mermaid' && toolOutput.content) {
          const identifier = `mermaid-${Date.now()}`;
          const title = toolOutput.metadata?.title || 'Mermaid Diagram';

          const artifactSyntax = `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">
${toolOutput.content}
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

  // Fallback: If no patterns matched, try a more aggressive approach
  if (processedContent === content && hasTargetType) {
    // Look for the basic structure: "result":"{ ... "type":"mermaid" ... }"
    const fallbackPattern = /"result":\s*"([^"]*(?:\\"[^"]*)*)"[^}]*\}/g;
    let fallbackMatch;

    while ((fallbackMatch = fallbackPattern.exec(content)) !== null) {
      const resultContent = fallbackMatch[1];

      // Check if this result contains our target types
      if (/(?:rechart|recharts|mermaid)/.test(resultContent)) {
        // Try to reconstruct the JSON by unescaping
        let reconstructed = resultContent;
        try {
          // Simple unescaping for the most common cases
          reconstructed = reconstructed.replace(/\\"/g, '"').replace(/\\n/g, '\n');

          // Try to parse as JSON
          const toolOutput = JSON.parse(reconstructed);

          if (toolOutput.type === 'mermaid' && toolOutput.content) {
            const identifier = `mermaid-${Date.now()}`;
            const title = toolOutput.metadata?.title || 'Mermaid Diagram';

            const artifactSyntax = `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">
${toolOutput.content}
</artifact>`;

            // Replace the original match with artifact syntax
            processedContent = processedContent.replace(fallbackMatch[0], artifactSyntax);
          }
        } catch (parseError) {
          console.warn('🔧 Fallback JSON parsing failed:', parseError);
        }
      }
    }
  }

  return processedContent;
}

/**
 * Post-processes AI responses to detect code blocks that should be artifacts
 * and converts them to proper artifact syntax as a fallback
 */
export function convertCodeBlocksToArtifacts(content: string): string {
  // First, detect tool outputs that should become artifacts
  content = convertToolOutputsToArtifacts(content);

  // Then process code blocks
  // Detect React component code blocks - use stricter matching
  // Match tsx/jsx explicitly, or javascript/typescript with React patterns
  const reactCodeBlockRegex = /```(tsx?|jsx|javascript|typescript)\s*([\s\S]*?)```/gi;

  content = content.replace(reactCodeBlockRegex, (match, language, codeContent) => {
    // For tsx/jsx, always treat as React
    if (language === 'tsx' || language === 'jsx') {
      const componentName = extractComponentName(codeContent) || 'component';
      const identifier = componentName.toLowerCase().replace(/[^a-z0-9]/g, '-');

      return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${componentName}">
${codeContent.trim()}
</artifact>`;
    }

    // For javascript/typescript, require strong React indicators
    // Count React-specific patterns (need at least 2 to convert)
    const hasReactHooks =
      /\buse(State|Effect|Context|Reducer|Callback|Memo|Ref|ImperativeHandle|LayoutEffect|DebugValue)\b/.test(
        codeContent
      );
    const hasJSXSyntax = /<[A-Z][a-zA-Z0-9]*[\s\/>]/.test(codeContent) || /<[a-z]+[^>]*\/>/.test(codeContent);
    const hasReactImport = /import\s+.*\s+from\s+['"]react['"]/.test(codeContent);
    const hasReactComponent = /extends\s+(?:React\.)?Component\b/.test(codeContent);
    const hasJSXReturn = /return\s*\(\s*</.test(codeContent);

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

  // Detect HTML code blocks
  const htmlCodeBlockRegex = /```html\s*((?:.*\n)*?.*<!DOCTYPE.*(?:\n.*)*?.*<\/html>.*(?:\n.*)*?)```/gi;

  content = content.replace(htmlCodeBlockRegex, (match, codeContent) => {
    const title = extractHTMLTitle(codeContent) || 'HTML Page';
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Promote ```html fences that lack a full <!DOCTYPE>...</html> document (HTML
  // fragments). The DOCTYPE-requiring regex above already converted full documents,
  // so any remaining ```html fence is a fragment - still better presented as a
  // previewable artifact than left as a raw code block.
  const htmlFragmentFenceRegex = /```html\s*\n?([\s\S]*?)```/gi;
  content = content.replace(htmlFragmentFenceRegex, (match, codeContent) => {
    // Require at least one HTML tag so a mislabeled fence of plain text is left alone.
    if (!/<[a-z][a-z0-9]*[\s/>]/i.test(codeContent)) return match;
    const title = extractHTMLTitle(codeContent) || 'HTML Snippet';
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${codeContent.trim()}
</artifact>`;
  });

  // Detect SVG code blocks
  const svgCodeBlockRegex = /```svg\s*((?:.*\n)*?.*<svg.*(?:\n.*)*?.*<\/svg>.*(?:\n.*)*?)```/gi;

  content = content.replace(svgCodeBlockRegex, (match, codeContent) => {
    const identifier = 'svg-graphic';

    return `<artifact identifier="${identifier}" type="image/svg+xml" title="SVG Graphic">
${codeContent.trim()}
</artifact>`;
  });

  // Detect Python code blocks - convert substantial Python code to Python artifacts
  const pythonCodeBlockRegex = /```(?:python|py)\s*([\s\S]*?)```/gi;

  content = content.replace(pythonCodeBlockRegex, (match, codeContent) => {
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
 * MUST STAY IN SYNC with the twin copy in b4m-core/utils/src/artifactParser.ts
 * so client render and server persistence never diverge.
 */
function promoteToolCallJsonArtifact(content: string): string {
  // Fence labels a model uses for a tool call; a ```html fence is handled above.
  // The negative lookahead stops ```tool matching inside ```tool_calls etc.
  const fenceRegex = /```(?:json|tool_code|tool)(?![a-z0-9_])\s*([\s\S]*?)```/gi;
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

  // Strip double quotes from the model-controlled title before interpolating it
  // into title="...": the artifact attribute parser (ATTRIBUTE_REGEX) has no
  // escape mechanism, so an embedded " would truncate the attribute. Apostrophes
  // are safe inside a double-quoted value and are kept.
  const title = (extractHTMLTitle(html) || 'HTML Page').replace(/"/g, '') || 'HTML Page';
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
 * otherwise render as raw HTML in the chat. Runs last so the fence/artifact guards
 * see all earlier conversions.
 */
function promoteBareHtmlDocument(content: string): string {
  const bareHtmlDocRegex = /(<!DOCTYPE\s+html[\s\S]*?<\/html\s*>|<html[\s\S]*?<\/html\s*>)/gi;
  return content.replace(bareHtmlDocRegex, (match, doc, offset, full: string) => {
    const before = full.slice(0, offset);
    // Skip if the document sits inside a code fence (odd number of ``` before it)...
    if ((before.match(/```/g) || []).length % 2 === 1) return match;
    // ...or inside an already-open <artifact> tag.
    const opens = (before.match(/<artifact\b/gi) || []).length;
    const closes = (before.match(/<\/artifact>/gi) || []).length;
    if (opens > closes) return match;
    const title = extractHTMLTitle(doc) || 'HTML Page';
    const identifier = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `<artifact identifier="${identifier}" type="text/html" title="${title}">
${doc.trim()}
</artifact>`;
  });
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
 * Extracts title from HTML content
 */
function extractHTMLTitle(code: string): string | null {
  const titleMatch = code.match(/<title>(.*?)<\/title>/i);
  return titleMatch ? titleMatch[1] : null;
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
 * cut). Used by the truncated-artifact detector in PromptReplies to decide
 * whether to best-effort close the tag or drop the partial.
 */
export function hasCompleteOpeningTag(tail: string): boolean {
  return new RegExp(`^<artifact\\s+${ARTIFACT_ATTRS_PATTERN}>`).test(tail);
}

// Re-export validation functions from the core utils package
export { validateMermaidSyntax } from '@bike4mind/utils/artifactParser';
