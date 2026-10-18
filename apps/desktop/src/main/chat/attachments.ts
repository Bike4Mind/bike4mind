import { basename, extname } from 'node:path';
import type { ChatAttachment, ChatAttachmentKind } from '@shared/chat';

/**
 * How much of a text file reaches the model, in bytes.
 *
 * A dropped log is routinely tens of megabytes, and the honest options are "refuse it" or
 * "send a prefix and say so". This is the second: 128 KiB is roughly 30k tokens, which fits
 * beside a real conversation in every context window this client can reach, and the marker
 * below tells the model what it is missing rather than letting it reason about a fragment it
 * believes is the whole file.
 */
export const TEXT_BYTE_CAP = 128 * 1024;

/** Ceiling on the stored bytes of one image. Above it the image is downscaled, then refused. */
export const IMAGE_BYTE_CAP = 4 * 1024 * 1024;

/** Nothing larger is even decoded: a 200MB raw photo is a mistake, not an attachment. */
export const IMAGE_INPUT_MAX = 32 * 1024 * 1024;

/**
 * Long-edge ceiling, in pixels. Anthropic resizes anything larger server-side anyway and bills
 * for the tokens, so shrinking here costs nothing and saves both.
 */
export const IMAGE_MAX_EDGE = 1568;

/** Per turn. Enough for "here are the three screenshots", far short of a dropped folder. */
export const MAX_ATTACHMENTS_PER_TURN = 10;

/** The image types every vision-capable provider in this stack accepts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Only these can be re-encoded without losing something (animation, in the other two). */
const SHRINKABLE = new Set(['image/png', 'image/jpeg']);

export function isImageMediaType(mediaType: string): boolean {
  return Object.values(IMAGE_MEDIA_TYPES).includes(mediaType);
}

export function imageMediaTypeForName(name: string): string | null {
  return IMAGE_MEDIA_TYPES[extname(name).toLowerCase()] ?? null;
}

/**
 * A name safe to put in a UI row and in an XML-ish attribute on the wire.
 *
 * Quotes and angle brackets are stripped rather than escaped: this is a display label, and a
 * name carrying a '"' would otherwise close the attribute early and let a crafted filename
 * inject attributes into the block the model reads.
 */
export function sanitizeName(raw: string): string {
  const cleaned = basename(raw)
    // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
    .replace(/[\u0000-\u001f"'<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || 'attachment';
}

/**
 * A buffer is binary if it holds a NUL or decodes with replacement characters.
 *
 * Checked on the head only, which is all that is read for a large file anyway. The NUL test
 * catches every common binary; the replacement test catches UTF-16 and mis-encoded text, which
 * would otherwise be inlined as mojibake.
 */
export function looksBinary(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.includes(0)) return true;
  // A trailing multi-byte sequence cut by the cap is not corruption, so ignore the last 4 bytes.
  const body = head.subarray(0, Math.max(0, head.length - 4));
  const decoded = body.toString('utf8');
  let replacements = 0;
  for (const char of decoded) if (char === '�') replacements++;
  return replacements > decoded.length * 0.01;
}

export interface PreparedAttachment {
  kind: ChatAttachmentKind;
  name: string;
  mediaType: string;
  /** What is written to disk and later sent. */
  bytes: Buffer;
  /** What the user picked, before truncation or downscaling. */
  sourceBytes: number;
  truncated?: boolean;
}

export type PrepareResult = { ok: true; prepared: PreparedAttachment } | { ok: false; reason: string };

/** Downscale/re-encode, or null when it cannot. Injected so only the caller imports Electron. */
export type ShrinkImage = (
  bytes: Buffer,
  mediaType: string,
  maxEdge: number
) => { bytes: Buffer; mediaType: string } | null;

export function prepareImage(name: string, mediaType: string, bytes: Buffer, shrink?: ShrinkImage): PrepareResult {
  const sourceBytes = bytes.length;
  if (sourceBytes === 0) return { ok: false, reason: 'That file is empty.' };
  if (sourceBytes > IMAGE_INPUT_MAX) {
    return {
      ok: false,
      reason: `That image is ${formatBytes(sourceBytes)}; the limit is ${formatBytes(IMAGE_INPUT_MAX)}.`,
    };
  }

  let out = { bytes, mediaType };
  // Always offered to the shrinker, not only when over the byte cap: an 800 KiB 4000px
  // screenshot is under the cap and still costs several times the tokens it needs to.
  if (shrink && SHRINKABLE.has(mediaType)) {
    const shrunk = shrink(bytes, mediaType, IMAGE_MAX_EDGE);
    if (shrunk && shrunk.bytes.length > 0 && shrunk.bytes.length < bytes.length) out = shrunk;
  }

  if (out.bytes.length > IMAGE_BYTE_CAP) {
    return {
      ok: false,
      reason: `That image is ${formatBytes(sourceBytes)} and could not be reduced under the ${formatBytes(
        IMAGE_BYTE_CAP
      )} limit.`,
    };
  }

  return {
    ok: true,
    prepared: { kind: 'image', name: sanitizeName(name), mediaType: out.mediaType, bytes: out.bytes, sourceBytes },
  };
}

/**
 * `head` is at most TEXT_BYTE_CAP + 1 bytes; `sourceBytes` is the real file size, which the
 * caller knows from a stat and this cannot infer from a deliberately short read.
 */
export function prepareText(name: string, head: Buffer, sourceBytes: number): PrepareResult {
  if (sourceBytes === 0) return { ok: false, reason: 'That file is empty.' };
  if (looksBinary(head)) {
    return { ok: false, reason: 'That looks like a binary file. Attach an image or a text file.' };
  }

  const safeName = sanitizeName(name);
  if (sourceBytes <= TEXT_BYTE_CAP) {
    return {
      ok: true,
      prepared: { kind: 'text', name: safeName, mediaType: 'text/plain', bytes: head, sourceBytes },
    };
  }

  // Cut at the last newline inside the cap so the model is not handed half a line, and say so
  // in the file itself: a prefix that reads as a whole file is what makes a model answer
  // confidently about data it never saw.
  const capped = head.subarray(0, TEXT_BYTE_CAP);
  const lastNewline = capped.lastIndexOf(0x0a);
  const body = lastNewline > TEXT_BYTE_CAP / 2 ? capped.subarray(0, lastNewline) : capped;
  const marker = `\n\n[... truncated: this is the first ${formatBytes(body.length)} of a ${formatBytes(
    sourceBytes
  )} file. The rest was not sent. Do not assume anything about the part you cannot see. ...]`;

  return {
    ok: true,
    prepared: {
      kind: 'text',
      name: safeName,
      mediaType: 'text/plain',
      bytes: Buffer.concat([body, Buffer.from(marker, 'utf8')]),
      sourceBytes,
      truncated: true,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One text attachment as the model reads it.
 *
 * Tagged rather than fenced: a log or a source file routinely contains a code fence itself,
 * which would end the fence early and leave the rest of the file reading as the user's own
 * instructions.
 */
export function textAttachmentBlock(attachment: ChatAttachment, body: string): string {
  const truncated = attachment.truncated ? ' truncated="true"' : '';
  return `<attached-file name="${attachment.name}" bytes="${attachment.sourceBytes}"${truncated}>\n${body}\n</attached-file>`;
}
