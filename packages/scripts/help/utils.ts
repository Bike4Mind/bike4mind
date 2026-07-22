/**
 * Shared utilities for the Help system
 * Used by both the index builder (Node.js) and the client (React)
 */

/**
 * Strip markdown inline formatting from text (bold, italic, code, links)
 * This ensures consistent text extraction from both raw markdown and rendered content
 */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // Bold **text**
    .replace(/\*(.+?)\*/g, '$1') // Italic *text*
    .replace(/__(.+?)__/g, '$1') // Bold __text__
    .replace(/_(.+?)_/g, '$1') // Italic _text_
    .replace(/`(.+?)`/g, '$1') // Inline code `text`
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Links [text](url)
    .trim();
}

/**
 * Convert a string to a URL-friendly anchor ID
 * This is the canonical anchor generation function used by both:
 * - The index builder (build-help-index.ts) for HelpHeading.anchor
 * - The React heading renderer (HelpContent.tsx) for <h*> id attributes
 *
 * IMPORTANT: Any changes here must be reflected in both places to keep anchors in sync
 */
export function toAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special characters (including emojis)
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .trim();
}

/**
 * Normalize path separators to forward slashes for cross-platform compatibility
 * Windows uses backslashes, but URLs always use forward slashes
 */
export function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Resolve a relative markdown link against a base help slug to a target slug.
 *
 * This is the canonical link-resolution function used by both:
 * - The React content renderer (HelpContent.tsx) to navigate between articles
 * - The content validator (validate-help-content.ts) to verify links resolve
 *
 * The `.md` extension is stripped; `#anchor` fragments must be removed by the
 * caller before calling this (it operates on the path portion only).
 *
 * Examples:
 *   resolveRelativePath('features/notebooks', './projects.md') -> 'features/projects'
 *   resolveRelativePath('features/notebooks', '../getting-started/intro.md') -> 'getting-started/intro'
 *   resolveRelativePath('features/notebooks', '/admin/users.md') -> 'admin/users'
 *
 * IMPORTANT: Any changes here must keep the renderer and validator in sync.
 */
export function resolveRelativePath(basePath: string, relativePath: string): string {
  // Remove .md extension
  let target = relativePath.replace(/\.md$/, '');

  // Get the directory of the base path
  const baseDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/')) : '';

  if (target.startsWith('./')) {
    // Same directory: ./file -> baseDir/file
    target = target.substring(2);
    return baseDir ? `${baseDir}/${target}` : target;
  } else if (target.startsWith('../')) {
    // Parent directory: ../file -> go up one level
    const parts = baseDir.split('/').filter(Boolean);
    let upCount = 0;

    while (target.startsWith('../')) {
      target = target.substring(3);
      upCount++;
    }

    // Remove 'upCount' directories from the base
    const remainingParts = parts.slice(0, Math.max(0, parts.length - upCount));
    return remainingParts.length > 0 ? `${remainingParts.join('/')}/${target}` : target;
  }

  // Absolute path or no prefix - return as-is (leading slash stripped)
  return target.startsWith('/') ? target.substring(1) : target;
}

/**
 * Video extensions the help renderer treats as gif-style demo videos
 * (autoplay, muted, looping), authored with the same ![alt](path) markdown
 * syntax as images.
 *
 * This is the canonical list used by:
 * - The React media renderer (HelpContent.tsx) to dispatch img vs video
 * - The content validator (validate-help-content.ts) to recognize/size-check media
 * - The bundler (bundle-help-content.ts) to copy media into public/help-content
 *
 * IMPORTANT: Any changes here must keep those three consumers in sync.
 */
export const VIDEO_EXTENSIONS = ['.webm', '.mp4'];

/** True when the path (or URL) ends in a supported help video extension. */
export function hasVideoExtension(target: string): boolean {
  const lower = target.toLowerCase();
  return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Approximate token count using chars/4 heuristic.
 * Good enough for budget management; avoids pulling in tiktoken as a dependency.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MarkdownSection {
  sectionPath: string;
  content: string;
}

/**
 * Split markdown content into sections by heading boundaries for RAG chunking.
 *
 * Primary split is at H2 (`## `) boundaries only. H3/H4+ content stays with
 * the parent H2 section to produce semantically coherent chunks in the
 * 200-500 token sweet spot.
 *
 * Safety nets:
 * - Intro text (before first H2) merges into the first H2 section.
 * - If an H2 section exceeds `maxSectionTokens`, it is re-split at H3
 *   boundaries (H4+ stays with parent H3).
 * - Sections smaller than `minSectionLength` chars merge forward (or backward
 *   if last).
 *
 * Used at build time (vectorize script) and at runtime (content resolution
 * for vector search results).
 */
export function chunkByHeadings(
  markdownContent: string,
  articleTitle: string,
  options?: {
    minSectionLength?: number;
    maxSectionTokens?: number;
  }
): MarkdownSection[] {
  const minSectionLength = options?.minSectionLength ?? 100;
  const maxSectionTokens = options?.maxSectionTokens ?? 800;

  const lines = markdownContent.split('\n');

  // --- Step 1: Split on H2 boundaries only ---
  interface RawSection {
    h2Heading: string | null;
    lines: string[];
  }
  const rawSections: RawSection[] = [];
  let current: RawSection = { h2Heading: null, lines: [] };

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match && !line.match(/^###/)) {
      // Flush previous
      rawSections.push(current);
      current = { h2Heading: h2Match[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  rawSections.push(current);

  // --- Step 2: Merge intro (before first H2) into first H2 section ---
  if (rawSections.length > 1 && rawSections[0].h2Heading === null) {
    const intro = rawSections.shift()!;
    const introText = intro.lines.join('\n').trim();
    if (introText) {
      rawSections[0].lines = [...intro.lines, ...rawSections[0].lines];
    }
  }

  // --- Step 3: Build MarkdownSections, splitting oversized H2s at H3 ---
  const sections: MarkdownSection[] = [];

  for (const raw of rawSections) {
    const content = raw.lines.join('\n').trim();
    if (!content) continue;

    const sectionPath = raw.h2Heading ?? articleTitle;
    const tokens = estimateTokenCount(content);

    if (tokens <= maxSectionTokens) {
      sections.push({ sectionPath, content });
    } else {
      // Re-split this H2 section at H3 boundaries
      const h3Sections = splitAtH3(raw.lines, raw.h2Heading ?? articleTitle);
      sections.push(...h3Sections);
    }
  }

  // --- Step 4: Merge small sections ---
  const merged: MarkdownSection[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const contentOnly = section.content.replace(/^#{1,6}\s+.+$/gm, '').trim();

    if (contentOnly.length < minSectionLength) {
      if (i < sections.length - 1) {
        // Merge forward into next section
        sections[i + 1].content = section.content + '\n\n' + sections[i + 1].content;
      } else if (merged.length > 0) {
        // Last section - merge backward into previous
        merged[merged.length - 1].content += '\n\n' + section.content;
      } else {
        // Only section - keep it
        merged.push(section);
      }
    } else {
      merged.push(section);
    }
  }

  return merged;
}

/**
 * Split lines within an H2 section at H3 boundaries.
 * H4+ headings stay with their parent H3. Intro lines before the first H3
 * become a standalone chunk with the H2 sectionPath.
 */
function splitAtH3(lines: string[], h2Heading: string): MarkdownSection[] {
  interface H3Section {
    h3Heading: string | null;
    lines: string[];
  }
  const parts: H3Section[] = [];
  let current: H3Section = { h3Heading: null, lines: [] };

  for (const line of lines) {
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match && !line.match(/^####/)) {
      parts.push(current);
      current = { h3Heading: h3Match[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  parts.push(current);

  // Merge intro (before first H3) into first H3 section if it exists
  if (parts.length > 1 && parts[0].h3Heading === null) {
    const intro = parts.shift()!;
    const introText = intro.lines.join('\n').trim();
    if (introText) {
      parts[0].lines = [...intro.lines, ...parts[0].lines];
    }
  }

  const sections: MarkdownSection[] = [];
  for (const part of parts) {
    const content = part.lines.join('\n').trim();
    if (!content) continue;

    const sectionPath = part.h3Heading ? `${h2Heading} > ${part.h3Heading}` : h2Heading;
    sections.push({ sectionPath, content });
  }

  return sections;
}

/**
 * Strip YAML frontmatter (--- delimited block) from the start of a markdown file.
 * Used at runtime to get raw markdown content from help articles.
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\n*/, '');
}

/**
 * Truncate a vector to `dimensions` and L2-normalize the result.
 * Returns the vector unchanged when it is already at or below the target
 * dimensionality. Supports Matryoshka dimension reduction - models like
 * text-embedding-3-small produce vectors whose first N dims remain useful
 * at lower dimensionality (e.g. 512 or 1024 instead of native 1536).
 */
export function truncateAndNormalize(vector: number[], dimensions: number): number[] {
  if (vector.length <= dimensions) return vector;
  const truncated = vector.slice(0, dimensions);
  const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return truncated;
  return truncated.map(v => v / norm);
}
