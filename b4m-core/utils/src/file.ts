import path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import invert from 'lodash/invert.js';
import { AudioMimeType, SupportedFabFileMimeTypes, isSupportedFabFileMimeType } from '@bike4mind/common';

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

// Any dot-tail is an extension that must resolve to a known type or be refused - a digit tail
// ("payload.1", "backup.001") is no exemption, or renaming a binary is enough to get it in.
const hasFileExtension = (fileName: string) => getFileExtension(fileName) !== '';

// A trailing dot ("payload.") is malformed rather than extension-less, so it gets
// no plain-text fallback: this is deliberately NOT the complement of hasFileExtension,
// which is false for such a name too. Shared by the Slack and web ingest doors so the
// two cannot drift apart again.
const isExtensionlessFileName = (fileName: string) => !hasFileExtension(fileName) && !fileName.endsWith('.');

/**
 * Returns the MIME type corresponding to a given file extension.
 * Special handling for configuration files and TypeScript files.
 */
export const getMimeTypeByExtension = (ext: string) => {
  const lowerExt = ext.toLowerCase();

  if (['ini', 'env', 'conf'].includes(lowerExt)) {
    return SupportedFabFileMimeTypes.TXT_PLAIN;
  }

  if (lowerExt === 'tsx' || lowerExt === 'ts') {
    return SupportedFabFileMimeTypes.TS;
  }

  // Markdown variants (.md and .mdx share the canonical markdown MIME type;
  // MIME_TO_EXT carries a legacy spelling that would otherwise win the invert)
  if (lowerExt === 'md' || lowerExt === 'mdx') {
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
 * Resolve the effective MIME type for an uploaded file: `mimeType` is what to persist (so the
 * chunker keys on a type it can process) and `supported` gates ingest. Under the default
 * `'extension-first'` a name whose extension does not resolve is refused outright, claim or no
 * claim. `'claim-first'` exists for a claim that comes from a trusted server-side source rather
 * than a client (Google Drive's stored metadata), where the user-renamable filename is worth less.
 *
 * @param fileName - Original file name (used to derive the extension).
 * @param claimedMimeType - The claimed MIME type, if any.
 * @param opts.isAcceptable - Predicate gating both extension- and claim-derived types; defaults
 * to `isSupportedFabFileMimeType`.
 * @param opts.precedence - Which of extension/claim is consulted first; defaults to
 * `'extension-first'`.
 * @param opts.extensionlessFallback - Type for a name carrying no extension at all (`LICENSE`,
 * `.env`) that also carried no claim. Omit it to keep a door strict.
 */
export function resolveSupportedMimeType(
  fileName: string,
  claimedMimeType?: string | null,
  opts: {
    isAcceptable?: (m: string | null | undefined) => boolean;
    precedence?: 'extension-first' | 'claim-first';
    extensionlessFallback?: SupportedFabFileMimeTypes;
  } = {}
): { mimeType: string; supported: boolean } {
  const { isAcceptable = isSupportedFabFileMimeType, precedence = 'extension-first', extensionlessFallback } = opts;
  const ext = getFileExtension(fileName);
  const byExtension = getMimeTypeByExtension(ext);
  // The `byExtension ?` guard is load-bearing: an unresolved extension has to yield null, or the
  // truthy `{ mimeType: '', supported: false }` wins the `??` chain and the claim is never read.
  const extensionResult = byExtension ? { mimeType: byExtension, supported: isAcceptable(byExtension) } : null;

  // An extension we do not know is refused outright rather than handed to the claim: letting it
  // through is how `malware.exe` claiming text/plain got admitted. A claim-first door trusts its
  // server-side claim over the filename by construction, so it is exempt.
  if (!extensionResult && ext !== '' && precedence !== 'claim-first') {
    return { mimeType: '', supported: false };
  }

  // `isAcceptable` is a plain predicate, so it cannot narrow `string | null | undefined` -
  // the truthiness check on `claimedMimeType` is what narrows it before the call.
  const claimResult =
    claimedMimeType && isAcceptable(claimedMimeType) ? { mimeType: claimedMimeType, supported: true } : null;

  const resolved = precedence === 'claim-first' ? (claimResult ?? extensionResult) : (extensionResult ?? claimResult);
  if (resolved) return resolved;

  // Only a name carrying no extension at all reaches the fallback, and a claim that was supplied
  // and rejected above stays rejected - coercing either is how an unsupported binary gets stored
  // and chunked as prose.
  if (extensionlessFallback && !claimedMimeType && isExtensionlessFileName(fileName)) {
    return { mimeType: extensionlessFallback, supported: isAcceptable(extensionlessFallback) };
  }

  return { mimeType: '', supported: false };
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

  // Audio: storable but never ingestable, so these resolve by extension and are then
  // refused or kept by the caller's predicate (isStorableFabFileMimeType accepts them).
  [AudioMimeType.MP3]: 'mp3',
  [AudioMimeType.WAV]: 'wav',
  [AudioMimeType.OPUS]: 'opus',
  [AudioMimeType.AAC]: 'aac',
  [AudioMimeType.FLAC]: 'flac',
  [AudioMimeType.PCM]: 'pcm',
  [AudioMimeType.OGG]: 'ogg',
  [AudioMimeType.WEBM]: 'webm',
} as const;

// Declared after the literal above, not beside its consumer: `MIME_TO_EXT` is a const, so an
// earlier invert() would hit its temporal dead zone at module load.
// Null-prototype: a plain object would resolve 'constructor'/'__proto__' to an inherited
// member, and the truthy result skips the `?? ''` in getMimeTypeByExtension.
const EXT_TO_MIME: Record<string, string> = Object.assign(Object.create(null), invert(MIME_TO_EXT));
