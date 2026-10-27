import { ArtifactPayload, ArtifactType, scanArtifactOpenTag } from '@bike4mind/common';
import { detectElidedContent } from '@bike4mind/utils/artifactElision';
import {
  type ArtifactParseResult,
  type ParsedArtifact,
  convertCodeBlocksToArtifacts,
  extractArtifactBlocks,
  isSvgGraphicallyEmpty,
} from '@bike4mind/utils/artifactParser';
import { tryParseChartJSON } from '@bike4mind/server-utils/app/utils/chartJsonParser';
import { scanImportStatements } from '@bike4mind/utils/importStatements';

// Block extraction, the shared types and every fence-promotion detector live in core, so the
// server's chat pass and this module agree on what a reply contains; this module keeps the
// render-specific tag stripping.
export type { ArtifactParseResult, ParsedArtifact };
export { isSvgGraphicallyEmpty };
export { convertCodeBlocksToArtifacts, hasSelfClosingTag } from '@bike4mind/utils/artifactParser';

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
 * Promotes fenced code and tool-output JSON to artifact tags, then parses and strips every tag.
 * The FULL content is converted once, never the text left after parsing: leftovers carry no
 * artifact spans, so core's mermaid dedupe could not see an explicit mermaid artifact and would
 * promote its duplicate fence a second time. Core also protects existing artifact spans from
 * the detectors, so an explicit artifact is never re-wrapped.
 *
 * Shared by the render path (PromptReplies) and the persistence paths
 * (useStreamingArtifactPersistence, persistAgentArtifacts) so agent and chat replies agree on
 * what a reply contains.
 */
export function parseArtifactsWithFallback(
  content: string,
  options?: { rechartsDisplayMode?: 'inline' | 'artifact' }
): ArtifactParseResult {
  return parseArtifacts(convertCodeBlocksToArtifacts(content, { rewriteNestedMarkdown: true }), options);
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
