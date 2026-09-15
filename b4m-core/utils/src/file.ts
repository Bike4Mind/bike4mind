import path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import invert from 'lodash/invert.js';
import { SupportedFabFileMimeTypes, isSupportedFabFileMimeType } from '@bike4mind/common';

/**
 * Detect a file's extension and MIME type: sniff the buffer first, then fall
 * back to the filename extension and a content/MIME heuristic.
 *
 * @param buffer - File content.
 * @param fileName - Used to infer the extension when sniffing fails.
 * @param currentMimeType - Used as-is when provided; otherwise inferred from content.
 * @returns Promise of `{ ext, mime }`.
 */
export async function getFileType(
  buffer: Buffer,
  fileName: string,
  currentMimeType: string = ''
): Promise<{
  ext: string;
  mime: string;
}> {
  const fileType = await fileTypeFromBuffer(buffer);

  if (fileType) {
    return { ext: fileType.ext, mime: fileType.mime };
  }

  let ext = getFileExtension(fileName);

  // Trust a caller-provided MIME type; otherwise treat text as text/plain and
  // everything else as binary.
  const mime =
    currentMimeType || (isPlainText(buffer) ? SupportedFabFileMimeTypes.TXT_PLAIN : 'application/octet-stream');

  ext = ext ?? MIME_TO_EXT[mime as keyof typeof MIME_TO_EXT] ?? '';

  return { ext, mime };
}

/**
 * Heuristic plain-text check: allow Tab/LF/CR, reject other control bytes, and
 * tolerate a small proportion of binary-like bytes.
 *
 * @param buffer - The Buffer to check.
 * @returns `true` if the buffer looks like plain text.
 */
export function isPlainText(buffer: Buffer): boolean {
  // Allowed control chars: Tab, LF, CR.
  const allowedControlChars = new Set([0x09, 0x0a, 0x0d]);

  // Classify as non-text once binary-like bytes exceed 10% of content.
  const binaryThreshold = 0.1;

  let binaryCount = 0;

  // @ts-ignore
  for (const byte of buffer) {
    if (byte < 0x20 && !allowedControlChars.has(byte)) {
      binaryCount++;
      if (binaryCount / buffer.length > binaryThreshold) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Decodes a Base64-encoded data URL into a Buffer.
 *
 * @param dataUrl - A Base64-encoded data URL (e.g., `data:image/png;base64,...`).
 *
 * @returns A Buffer containing the decoded data.
 */
export function decodeBase64DataUrl(dataUrl: string): Buffer {
  const base64Data = dataUrl.replace(/^data:.*;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Extracts the extension from a file name and returns it in lowercase without the leading dot.
 *
 * @param fileName
 * @returns `string`
 */
export const getFileExtension = (fileName: string) => {
  return path.extname(fileName).toLowerCase().slice(1);
};

/**
 * Returns the MIME type corresponding to a given file extension.
 * Special handling for configuration files and TypeScript files.
 */
export const getMimeTypeByExtension = (ext: string) => {
  const EXT_TO_MIME = invert(MIME_TO_EXT);
  const lowerExt = ext.toLowerCase();

  if (['ini', 'env', 'conf'].includes(lowerExt)) {
    return SupportedFabFileMimeTypes.TXT_PLAIN;
  }

  if (lowerExt === 'tsx' || lowerExt === 'ts') {
    return SupportedFabFileMimeTypes.TS;
  }

  // Markdown variants (.mdx shares the markdown MIME type)
  if (lowerExt === 'mdx') {
    return SupportedFabFileMimeTypes.TXT_MARKDOWN;
  }

  if (lowerExt === 'xls') {
    return SupportedFabFileMimeTypes.XLS;
  }
  if (lowerExt === 'xlsx') {
    return SupportedFabFileMimeTypes.XLSX;
  }
  if (lowerExt === 'docx') {
    return SupportedFabFileMimeTypes.DOCX;
  }
  if (lowerExt === 'pptx') {
    return SupportedFabFileMimeTypes.PPTX;
  }

  // .jpeg shares the .jpg MIME type (MIME_TO_EXT only carries the 'jpg' spelling)
  if (lowerExt === 'jpeg') {
    return SupportedFabFileMimeTypes.JPG;
  }

  return EXT_TO_MIME[lowerExt] ?? '';
};

/**
 * Resolve the effective, supported MIME type for an uploaded file.
 *
 * Browsers frequently report an empty or generic (`application/octet-stream`)
 * MIME type - even for supported code/text files (e.g. `.py`, `.ts`). We trust
 * a claimed type only if it's already supported; otherwise we derive the type
 * from the file extension. The returned `mimeType` is what should be persisted
 * (so the chunker keys on a type it can actually process), and `supported`
 * gates ingest so unsupported/binary files (e.g. `.exe`) are rejected.
 *
 * @param fileName - Original file name (used to derive the extension).
 * @param claimedMimeType - The browser/client-provided MIME type, if any.
 */
export function resolveSupportedMimeType(
  fileName: string,
  claimedMimeType?: string | null
): { mimeType: string; supported: boolean } {
  if (isSupportedFabFileMimeType(claimedMimeType)) {
    return { mimeType: claimedMimeType, supported: true };
  }
  const byExtension = getMimeTypeByExtension(getFileExtension(fileName));
  return { mimeType: byExtension, supported: isSupportedFabFileMimeType(byExtension) };
}

const MIME_TO_EXT = {
  // Text and documents
  [SupportedFabFileMimeTypes.TXT_PLAIN]: 'txt', // Default extension for plain text, also used for .ini and .env
  [SupportedFabFileMimeTypes.TXT_MARKDOWN]: 'md',
  [SupportedFabFileMimeTypes.TXT_MD_LEGACY]: 'md',
  [SupportedFabFileMimeTypes.HTML]: 'html',
  [SupportedFabFileMimeTypes.CSV]: 'csv',

  // Images
  [SupportedFabFileMimeTypes.JPG]: 'jpg',
  [SupportedFabFileMimeTypes.PNG]: 'png',
  [SupportedFabFileMimeTypes.GIF]: 'gif',
  [SupportedFabFileMimeTypes.SVG]: 'svg',
  [SupportedFabFileMimeTypes.WEBP]: 'webp',

  // Documents
  [SupportedFabFileMimeTypes.PDF]: 'pdf',
  [SupportedFabFileMimeTypes.JSON]: 'json',
  [SupportedFabFileMimeTypes.XML]: 'xml',
  [SupportedFabFileMimeTypes.DOCX]: 'docx',
  [SupportedFabFileMimeTypes.PPTX]: 'pptx',
  [SupportedFabFileMimeTypes.XLSX]: 'xlsx',
  [SupportedFabFileMimeTypes.XLS]: 'xls',

  // Programming languages
  [SupportedFabFileMimeTypes.JS]: 'js',
  [SupportedFabFileMimeTypes.JSX]: 'jsx',
  [SupportedFabFileMimeTypes.TS]: 'ts', // TSX also maps to 'text/typescript' but is handled separately
  [SupportedFabFileMimeTypes.PY]: 'py',
  [SupportedFabFileMimeTypes.JAVA]: 'java',
  [SupportedFabFileMimeTypes.CPP]: 'cpp',
  [SupportedFabFileMimeTypes.CS]: 'cs',
  [SupportedFabFileMimeTypes.PHP]: 'php',
  [SupportedFabFileMimeTypes.RUBY]: 'rb',
  [SupportedFabFileMimeTypes.GO]: 'go',
  [SupportedFabFileMimeTypes.SWIFT]: 'swift',
  [SupportedFabFileMimeTypes.KOTLIN]: 'kt',
  [SupportedFabFileMimeTypes.RUST]: 'rs',
  [SupportedFabFileMimeTypes.CSS]: 'css',
  [SupportedFabFileMimeTypes.LESS]: 'less',
  [SupportedFabFileMimeTypes.SASS]: 'sass',
  [SupportedFabFileMimeTypes.SCSS]: 'scss',

  // Data serialization
  [SupportedFabFileMimeTypes.YAML]: 'yaml',
  [SupportedFabFileMimeTypes.TOML]: 'toml',

  // Shell scripts
  [SupportedFabFileMimeTypes.SH]: 'sh',
  [SupportedFabFileMimeTypes.BASH]: 'bash',
} as const;
