/**
 * Truncates markdown by line count, then closes any constructs left open by the
 * cut (code fences, emphasis, links) so the output stays valid markdown.
 */

interface TruncateMarkdownOptions {
  /** Maximum number of lines to include */
  maxLines: number;
  /** Whether to add ellipsis when truncated (default: true) */
  ellipsis?: boolean;
  /** Custom ellipsis string (default: '\n\n...') */
  ellipsisString?: string;
}

interface TruncateMarkdownResult {
  /** The truncated markdown content */
  content: string;
  /** Whether the content was actually truncated */
  wasTruncated: boolean;
  /** Original line count */
  originalLineCount: number;
}

/**
 * Tracks the state of open markdown constructs
 */
interface MarkdownState {
  /** Stack of open code block markers (``` or `) */
  codeBlocks: string[];
  /** Count of unclosed ** markers */
  boldDoubleAsterisk: number;
  /** Count of unclosed __ markers */
  boldDoubleUnderscore: number;
  /** Count of unclosed * markers (for italic) */
  italicAsterisk: number;
  /** Count of unclosed _ markers (for italic) */
  italicUnderscore: number;
  /** Count of unclosed ~~ markers (strikethrough) */
  strikethrough: number;
  /** Whether we're inside a link text [...]  */
  inLinkText: boolean;
  /** Whether we're inside a link url (...) */
  inLinkUrl: boolean;
}

function createInitialState(): MarkdownState {
  return {
    codeBlocks: [],
    boldDoubleAsterisk: 0,
    boldDoubleUnderscore: 0,
    italicAsterisk: 0,
    italicUnderscore: 0,
    strikethrough: 0,
    inLinkText: false,
    inLinkUrl: false,
  };
}

function isInCodeBlock(state: MarkdownState): boolean {
  return state.codeBlocks.length > 0;
}

/**
 * Updates markdown state for one line, tracking opened/closed constructs.
 */
function updateStateForLine(state: MarkdownState, line: string): void {
  // Check for fenced code blocks first (```language or ```)
  const fencedCodeMatch = line.match(/^(\s*)(```+)/);
  if (fencedCodeMatch) {
    const fence = fencedCodeMatch[2];
    if (state.codeBlocks.length > 0 && state.codeBlocks[state.codeBlocks.length - 1] === fence) {
      // Closing an existing code block
      state.codeBlocks.pop();
    } else if (state.codeBlocks.length === 0) {
      // Opening a new code block
      state.codeBlocks.push(fence);
    }
    return; // Don't process other markers inside code fence lines
  }

  // If we're inside a code block, don't process other markers
  if (isInCodeBlock(state)) {
    return;
  }

  // Track inline constructs by scanning the line; escape handling and match order matter.

  let i = 0;
  while (i < line.length) {
    // Skip escaped characters
    if (line[i] === '\\' && i + 1 < line.length) {
      i += 2;
      continue;
    }

    // Check for inline code (backticks) - these prevent other formatting inside
    if (line[i] === '`') {
      // Find the end of inline code
      const endIndex = line.indexOf('`', i + 1);
      if (endIndex !== -1) {
        i = endIndex + 1;
        continue;
      }
    }

    // Check for strikethrough ~~
    if (line.slice(i, i + 2) === '~~') {
      state.strikethrough = (state.strikethrough + 1) % 2;
      i += 2;
      continue;
    }

    // Check for bold ** (must check before single *)
    if (line.slice(i, i + 2) === '**') {
      state.boldDoubleAsterisk = (state.boldDoubleAsterisk + 1) % 2;
      i += 2;
      continue;
    }

    // Check for bold __ (must check before single _)
    if (line.slice(i, i + 2) === '__') {
      state.boldDoubleUnderscore = (state.boldDoubleUnderscore + 1) % 2;
      i += 2;
      continue;
    }

    // Check for italic * (single asterisk not followed by another)
    if (line[i] === '*' && line[i + 1] !== '*') {
      // Check if it's at word boundary (simplified check)
      state.italicAsterisk = (state.italicAsterisk + 1) % 2;
      i += 1;
      continue;
    }

    // Check for italic _ (single underscore not followed by another)
    if (line[i] === '_' && line[i + 1] !== '_') {
      // Check if it's at word boundary (simplified check)
      state.italicUnderscore = (state.italicUnderscore + 1) % 2;
      i += 1;
      continue;
    }

    // Check for link/image start
    if (line[i] === '[' && !state.inLinkText) {
      state.inLinkText = true;
      i += 1;
      continue;
    }

    // Check for link text end and URL start
    if (line.slice(i, i + 2) === '](' && state.inLinkText) {
      state.inLinkText = false;
      state.inLinkUrl = true;
      i += 2;
      continue;
    }

    // Check for link URL end
    if (line[i] === ')' && state.inLinkUrl) {
      state.inLinkUrl = false;
      i += 1;
      continue;
    }

    // Check for abandoned link text (] without ()
    if (line[i] === ']' && state.inLinkText && line[i + 1] !== '(') {
      state.inLinkText = false;
      i += 1;
      continue;
    }

    i += 1;
  }
}

/**
 * Generates closing markers for any unclosed markdown constructs
 */
function generateClosingMarkers(state: MarkdownState): string {
  const closings: string[] = [];

  // Close inline constructs first (in reverse order of typical nesting)
  if (state.inLinkUrl) {
    closings.push(')');
  }
  if (state.inLinkText) {
    closings.push('](...)'); // Close with placeholder URL
  }
  if (state.strikethrough) {
    closings.push('~~');
  }
  if (state.italicAsterisk) {
    closings.push('*');
  }
  if (state.italicUnderscore) {
    closings.push('_');
  }
  if (state.boldDoubleAsterisk) {
    closings.push('**');
  }
  if (state.boldDoubleUnderscore) {
    closings.push('__');
  }

  // Close code blocks (each one needs its own closing fence)
  for (const fence of state.codeBlocks) {
    closings.push('\n' + fence);
  }

  return closings.join('');
}

/**
 * Truncates markdown content by line count while preserving valid markdown syntax.
 *
 * @param content - The markdown content to truncate
 * @param options - Truncation options
 * @returns The truncated content and metadata
 *
 * @example
 * ```typescript
 * const result = truncateMarkdown(longMarkdown, { maxLines: 10 });
 * if (result.wasTruncated) {
 *   console.log(`Truncated from ${result.originalLineCount} to 10 lines`);
 * }
 * ```
 */
export function truncateMarkdown(content: string, options: TruncateMarkdownOptions): TruncateMarkdownResult {
  const { maxLines, ellipsis = true, ellipsisString = '\n\n...' } = options;

  if (!content) {
    return {
      content: '',
      wasTruncated: false,
      originalLineCount: 0,
    };
  }

  const lines = content.split('\n');
  const originalLineCount = lines.length;

  if (lines.length <= maxLines) {
    return {
      content,
      wasTruncated: false,
      originalLineCount,
    };
  }

  const truncatedLines = lines.slice(0, maxLines);

  // Track markdown state through the truncated content
  const state = createInitialState();
  for (const line of truncatedLines) {
    updateStateForLine(state, line);
  }

  let truncatedContent = truncatedLines.join('\n');

  const closingMarkers = generateClosingMarkers(state);
  truncatedContent += closingMarkers;

  if (ellipsis) {
    truncatedContent += ellipsisString;
  }

  return {
    content: truncatedContent,
    wasTruncated: true,
    originalLineCount,
  };
}

/**
 * Returns only the truncated string.
 */
export function truncateMarkdownString(content: string, maxLines: number, addEllipsis = true): string {
  return truncateMarkdown(content, { maxLines, ellipsis: addEllipsis }).content;
}

export default truncateMarkdown;
