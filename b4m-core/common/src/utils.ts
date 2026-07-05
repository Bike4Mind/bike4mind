// Helper function to determine MIME type based on file extension

import { SnippetMeta, SnippetSection } from './types';

// TODO: Move this to a shared utility function
export function determineMimeType(fileName: string, currentMimeType: string): string {
  if (currentMimeType !== '') {
    return currentMimeType;
  }

  const extension = fileName.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'md':
      return 'text/markdown';
    case 'mdx':
      return 'text/markdown';
    default:
      return currentMimeType;
  }
}

export function isValidEnumValue<T extends { [K: string]: string }>(value: string, enumObj: T): value is T[keyof T] {
  return Object.values(enumObj).includes(value);
}

// Brand identity, externalized for open-core. No brand fallback - empty when the
// operator hasn't set APP_NAME / WEBSITE_URL - so a fresh clone never ships a hardcoded
// "Bike4Mind" literal. Injected into every lambda via DEFAULT_LAMBDA_ENVIRONMENT.
export const APP_NAME = process.env.APP_NAME || '';
export const WEBSITE_URL = process.env.WEBSITE_URL || '';

/**
 * Human-facing brand/display name for PROSE contexts. Unlike the raw {@link APP_NAME}
 * constant - which is empty when unset, preserving the no-brand-fallback invariant for
 * machine/template contexts - this returns a neutral word so user-facing copy
 * ("Welcome to the app") never renders broken or with a dangling article when the operator
 * hasn't set APP_NAME. Use APP_NAME where empty-is-correct; use this in prose.
 */
export const getBrandName = (): string => APP_NAME || 'the app';

/**
 * Constructs a URL for the main website
 * @param path Optional path to append to the website URL
 * @returns The complete URL (empty base when WEBSITE_URL is unconfigured)
 */
export const getWebsiteUrl = (path?: string): string => {
  return path ? `${WEBSITE_URL}/${path.replace(/^\//, '')}` : WEBSITE_URL;
};

/**
 * Format file size in bytes to human-readable format (e.g., "1.5 MB", "256.0 KB")
 * @param bytes - File size in bytes
 * @returns Formatted string with appropriate unit
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Get emoji icon based on file MIME type for visual indication
 * @param mimeType - The MIME type of the file (e.g., "image/png", "application/pdf")
 * @returns Emoji representing the file type
 */
export function getFileTypeEmoji(mimeType: string): string {
  const type = mimeType.toLowerCase();

  // Images
  if (type.startsWith('image/')) return '🖼️';

  // Documents
  if (type === 'application/pdf') return '📄';
  if (type.includes('word') || type.includes('document')) return '📄';

  // Spreadsheets
  if (type.includes('spreadsheet') || type.includes('excel') || type === 'text/csv') return '📊';

  // Presentations
  if (type.includes('presentation') || type.includes('powerpoint')) return '📽️';

  // Archives
  if (type.includes('zip') || type.includes('tar') || type.includes('compressed') || type.includes('archive'))
    return '📦';

  // Audio
  if (type.startsWith('audio/')) return '🎵';

  // Video
  if (type.startsWith('video/')) return '🎬';

  // Text/Code
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('javascript'))
    return '📝';

  // Default
  return '📎';
}

/**
 * Common MIME type mappings for attachment detection
 */
export const MIME_TYPE_MAP: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  // Text
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.md': 'text/markdown',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  // Code/Config
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.java': 'text/x-java-source',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.log': 'text/plain',
};

/**
 * Detect MIME type from filename extension
 */
export function detectMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  const dotIndex = lower.lastIndexOf('.');
  const ext = dotIndex >= 0 ? lower.slice(dotIndex) : '';
  return MIME_TYPE_MAP[ext] || 'application/octet-stream';
}

/**
 * Resolve a file extension (without leading dot) from a MIME type.
 *
 * This is the inverse of {@link detectMimeType}. Use it instead of naively
 * splitting a MIME string (e.g. `mime.split('/')[1]`), which produces garbage
 * extensions for structured types - for example the Excel content type
 * `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` would
 * yield a bogus `.sheet` (or the whole subtype) rather than `.xlsx`.
 *
 * Returns `undefined` for unknown types so callers can pick their own default.
 */
export function extensionFromMimeType(mimeType: string): string | undefined {
  if (!mimeType) return undefined;
  // Drop any parameters (e.g. "; charset=utf-8") and normalize case
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  // First match wins, so canonical extensions (.jpg before .jpeg) are preferred
  for (const [ext, mime] of Object.entries(MIME_TYPE_MAP)) {
    if (mime === normalized) return ext.slice(1); // strip leading dot
  }
  return undefined;
}

// Helper for parallel processing with concurrency limit
export async function parallelLimit<T, R>(items: T[], limit: number, asyncFn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function next(): Promise<void> {
    if (i >= items.length) return;
    const current = i++;
    results[current] = await asyncFn(items[current]);
    return next();
  }
  const runners = Array.from({ length: limit }, () => next());
  await Promise.allSettled(runners);
  return results;
}

export const extractSnippetMeta = (content: string): { sections: SnippetSection[] } => {
  const snippetRegex = /<!--snippet-meta\s*(\{[\s\S]*?\})\s*-->[\n\s]*([\s\S]*?)(?=<!--snippet-meta|$)/g;
  const sections: SnippetSection[] = [];
  let lastIndex = 0;
  let match;

  // Find all snippets
  while ((match = snippetRegex.exec(content)) !== null) {
    // Add text before snippet if any
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index).trim();
      if (textBefore) {
        sections.push({ type: 'text', content: textBefore });
      }
    }

    try {
      const meta = JSON.parse(match[1]) as SnippetMeta;
      const snippetContent = match[2].trim();
      if (meta && snippetContent) {
        sections.push({ type: 'snippet', meta, content: snippetContent });
      }
    } catch (e) {
      console.error('Error parsing snippet meta:', e);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text if any
  if (lastIndex < content.length) {
    const remainingText = content.slice(lastIndex).trim();
    if (remainingText) {
      sections.push({ type: 'text', content: remainingText });
    }
  }

  return { sections };
};
