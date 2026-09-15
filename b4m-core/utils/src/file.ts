import path from 'path';
import { fileTypeFromBuffer } from 'file-type';
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

  // getFileExtension always returns a string (possibly ''), so there is no mime -> ext
  // fallback here. For a genuine mime -> extension lookup, see extensionFromMimeType in
  // @bike4mind/common.
  const ext = getFileExtension(fileName);

  // Trust a caller-provided MIME type; otherwise treat text as text/plain and
  // everything else as binary.
  const mime =
    currentMimeType || (isPlainText(buffer) ? SupportedFabFileMimeTypes.TXT_PLAIN : 'application/octet-stream');

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
 * Returns the MIME type corresponding to a given file extension, or '' if unresolved.
 */
export const getMimeTypeByExtension = (ext: string) => {
  const lowerExt = ext.toLowerCase();
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

// The extension allowlist: every key is a deliberate admission decision, canonical and
// alias spellings alike, as ordinary co-equal entries. Must stay in sync with
// `guessMimeType` in apps/client/app/utils/folderTreeParser.ts, the client-side map this
// table is meant to agree with.
// Null-prototype: a plain object would resolve 'constructor'/'__proto__' to an inherited
// member, and the truthy result skips the `?? ''` in getMimeTypeByExtension.
const EXT_TO_MIME: Record<string, string> = Object.assign(Object.create(null), {
  // Text and documents
  txt: SupportedFabFileMimeTypes.TXT_PLAIN, // Default extension for plain text, also used for .ini and .env
  ini: SupportedFabFileMimeTypes.TXT_PLAIN,
  env: SupportedFabFileMimeTypes.TXT_PLAIN,
  conf: SupportedFabFileMimeTypes.TXT_PLAIN,
  log: SupportedFabFileMimeTypes.TXT_PLAIN,
  // Browser-reported spelling with no client-side counterpart in guessMimeType - it
  // belongs only here, where a claim needs an extension-side match.
  text: SupportedFabFileMimeTypes.TXT_PLAIN,
  md: SupportedFabFileMimeTypes.TXT_MARKDOWN,
  mdx: SupportedFabFileMimeTypes.TXT_MARKDOWN,
  html: SupportedFabFileMimeTypes.HTML,
  htm: SupportedFabFileMimeTypes.HTML,
  // Browser-reported spelling with no client-side counterpart in guessMimeType.
  shtml: SupportedFabFileMimeTypes.HTML,
  csv: SupportedFabFileMimeTypes.CSV,

  // Images
  jpg: SupportedFabFileMimeTypes.JPG,
  jpeg: SupportedFabFileMimeTypes.JPG,
  jfif: SupportedFabFileMimeTypes.JPG, // Windows/Chrome "Save As" spelling for a JPEG.
  // Browser-reported spelling with no client-side counterpart in guessMimeType.
  jpe: SupportedFabFileMimeTypes.JPG,
  png: SupportedFabFileMimeTypes.PNG,
  gif: SupportedFabFileMimeTypes.GIF,
  svg: SupportedFabFileMimeTypes.SVG,
  webp: SupportedFabFileMimeTypes.WEBP,

  // Documents
  pdf: SupportedFabFileMimeTypes.PDF,
  json: SupportedFabFileMimeTypes.JSON,
  xml: SupportedFabFileMimeTypes.XML,
  docx: SupportedFabFileMimeTypes.DOCX,
  pptx: SupportedFabFileMimeTypes.PPTX,
  xlsx: SupportedFabFileMimeTypes.XLSX,
  xls: SupportedFabFileMimeTypes.XLS,

  // Programming languages
  js: SupportedFabFileMimeTypes.JS,
  jsx: SupportedFabFileMimeTypes.JSX,
  ts: SupportedFabFileMimeTypes.TS,
  tsx: SupportedFabFileMimeTypes.TS, // TSX shares TS's MIME type ('text/typescript').
  py: SupportedFabFileMimeTypes.PY,
  java: SupportedFabFileMimeTypes.JAVA,
  cpp: SupportedFabFileMimeTypes.CPP,
  cs: SupportedFabFileMimeTypes.CS,
  php: SupportedFabFileMimeTypes.PHP,
  rb: SupportedFabFileMimeTypes.RUBY,
  go: SupportedFabFileMimeTypes.GO,
  swift: SupportedFabFileMimeTypes.SWIFT,
  kt: SupportedFabFileMimeTypes.KOTLIN,
  rs: SupportedFabFileMimeTypes.RUST,
  css: SupportedFabFileMimeTypes.CSS,
  less: SupportedFabFileMimeTypes.LESS,
  sass: SupportedFabFileMimeTypes.SASS,
  scss: SupportedFabFileMimeTypes.SCSS,

  // Data serialization
  yaml: SupportedFabFileMimeTypes.YAML,
  yml: SupportedFabFileMimeTypes.YAML,
  toml: SupportedFabFileMimeTypes.TOML,

  // Shell scripts
  sh: SupportedFabFileMimeTypes.SH,
  bash: SupportedFabFileMimeTypes.BASH,

  // Audio: storable but never ingestable, so these resolve by extension and are then
  // refused or kept by the caller's predicate (isStorableFabFileMimeType accepts them).
  mp3: AudioMimeType.MP3,
  wav: AudioMimeType.WAV,
  opus: AudioMimeType.OPUS,
  aac: AudioMimeType.AAC,
  flac: AudioMimeType.FLAC,
  pcm: AudioMimeType.PCM,
  // .webm and .ogg are container extensions that can hold video, so a WebM video still
  // resolves to audio/webm here and is stored - never chunked - at a storable door; the
  // storable predicate, not this table, is what gates them.
  ogg: AudioMimeType.OGG,
  webm: AudioMimeType.WEBM,
});
