import type { ImageMediaType } from '../../main/chat/attachments';

export type StoredAttachmentContent = { ok: true; content: string } | { ok: false; reason: 'notReadable' };

const startsWith = (bytes: Buffer, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map(character => character.charCodeAt(0));

/** The image type the bytes themselves say, among the types intake stores; null for anything else. */
export function sniffImageMediaType(bytes: Buffer): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

/**
 * A stored attachment as a client can show it: an image as a `data:` URL, text as text. The type
 * comes from the bytes, never from the caller, so no caller can choose what lands in that URL. A
 * PDF is refused: it can be far larger than a protocol frame, and intake already holds its text.
 */
export function storedAttachmentContent(bytes: Buffer): StoredAttachmentContent {
  const imageType = sniffImageMediaType(bytes);
  if (imageType) return { ok: true, content: `data:${imageType};base64,${bytes.toString('base64')}` };
  if (startsWith(bytes, ascii('%PDF-'))) return { ok: false, reason: 'notReadable' };
  return { ok: true, content: bytes.toString('utf8') };
}
