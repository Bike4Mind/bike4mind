export type SniffedImageFormat = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at byte offset 8 of a RIFF container

function startsWith(buffer: Buffer, signature: number[], offset = 0): boolean {
  return buffer.length >= offset + signature.length && signature.every((byte, i) => buffer[offset + i] === byte);
}

/**
 * Identifies a PNG, JPEG or WebP image from its magic bytes, the three formats gpt-image's
 * edit endpoint accepts. Returns undefined for anything else (GIF, HEIC, unrecognized bytes).
 */
export function sniffImageFormat(buffer: Buffer): SniffedImageFormat | undefined {
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (startsWith(buffer, RIFF_SIGNATURE) && startsWith(buffer, WEBP_SIGNATURE, 8)) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return undefined;
}
