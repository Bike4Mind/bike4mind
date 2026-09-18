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
  // Audio (generated TTS / sound effects; canonical extension first per type
  // so extensionFromMimeType prefers .mp3 for audio/mpeg)
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.pcm': 'audio/pcm',
  '.ogg': 'audio/ogg',
  '.weba': 'audio/webm',
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

const SNIPPET_META_OPEN = '<!--snippet-meta';
const SNIPPET_META_CLOSE = '-->';

/** Index of the first non-whitespace character at or after `from`. */
const skipSpaceForward = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
};

/** Index just past the last non-whitespace character before `before`. */
const skipSpaceBackward = (text: string, before: number): number => {
  let i = before;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
};

/**
 * Split a prompt into its `<!--snippet-meta {...}-->` sections and the text around them.
 *
 * Scanned with indexOf rather than a regex. The regex this replaces backtracked
 * super-linearly on a marker whose JSON never closed, which invited a parse cap - but a
 * cap could not be applied safely here: the section pattern was terminated by
 * `(?=<!--snippet-meta|$)`, so capping moved `$` and changed section SHAPE, not just
 * length. Past the cap a snippet re-emitted as a `text` section, and callers that skip
 * snippets when collecting URLs to fetch (utils/src/llm/utils.ts) would start fetching
 * them. A linear scan needs no cap, so the shape is the same at every input length.
 */
export const extractSnippetMeta = (content: string): { sections: SnippetSection[] } => {
  const sections: SnippetSection[] = [];
  // Start of the text run not yet emitted, and where to resume looking for a marker.
  let cursor = 0;
  let search = 0;

  while (search < content.length) {
    const open = content.indexOf(SNIPPET_META_OPEN, search);
    if (open === -1) break;

    const metaStart = skipSpaceForward(content, open + SNIPPET_META_OPEN.length);
    if (content[metaStart] !== '{') {
      search = open + SNIPPET_META_OPEN.length;
      continue;
    }

    // Take the first `-->` that leaves a brace-delimited body behind it, so a `-->`
    // inside a JSON string value does not end the marker early. The boundary test is
    // O(1) per candidate and the indexOf scans never overlap, so this stays linear.
    let close = content.indexOf(SNIPPET_META_CLOSE, metaStart);
    while (close !== -1) {
      const metaEnd = skipSpaceBackward(content, close);
      if (metaEnd > metaStart && content[metaEnd - 1] === '}') break;
      close = content.indexOf(SNIPPET_META_CLOSE, close + SNIPPET_META_CLOSE.length);
    }
    if (close === -1) break;

    const bodyStart = close + SNIPPET_META_CLOSE.length;
    const nextMarker = content.indexOf(SNIPPET_META_OPEN, bodyStart);
    const bodyEnd = nextMarker === -1 ? content.length : nextMarker;

    const textBefore = content.slice(cursor, open).trim();
    if (textBefore) {
      sections.push({ type: 'text', content: textBefore });
    }

    try {
      const meta = JSON.parse(content.slice(metaStart, skipSpaceBackward(content, close))) as SnippetMeta;
      const snippetContent = content.slice(bodyStart, bodyEnd).trim();
      if (meta && snippetContent) {
        sections.push({ type: 'snippet', meta, content: snippetContent });
      }
    } catch (e) {
      console.error('Error parsing snippet meta:', e);
    }

    cursor = bodyEnd;
    search = bodyEnd;
  }

  const remainingText = content.slice(cursor).trim();
  if (remainingText) {
    sections.push({ type: 'text', content: remainingText });
  }

  return { sections };
};
