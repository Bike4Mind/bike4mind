// jsdom (this package's default test environment) runs in a separate vm realm whose
// Buffer isn't `instanceof` that realm's Uint8Array - `file-type`'s `fileTypeFromBuffer`
// relies on that check, so this suite needs the real node environment (same
// convention as other apps/client/server/**/*.test.ts files that touch Buffer/fs).
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ImageModerationBlockedError, UnsupportedImageFormatError } from '@bike4mind/utils';
import { moderateUploadedFile, isTerminalModerationStatus } from './moderateUploadedFile';

// Fakes for the injected deps - no AWS, no DB.
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() } as any;

// Real magic-number signatures so `fileTypeFromBuffer` sniffs something
// meaningful instead of returning undefined for arbitrary junk bytes. `file-type`'s PNG
// detector actually parses the IHDR chunk (not just the 8-byte signature), so this must be
// a structurally valid PNG - a minimal real 1x1 transparent pixel, not hand-rolled bytes.
const PNG_SIGNATURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const PDF_SIGNATURE = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]);
// Neither a real PNG nor a real PDF - file-type can't sniff this, so callers fall back to
// the declared mimeType (documents the "sniff inconclusive" branch).
const UNSNIFFABLE_BYTES = Buffer.from('just some plain text, not a real file');
// A ZIP local-file header - what a partial read of an OOXML file (docx/xlsx/pptx) sniffs as
// when the OOXML marker entries sit past the sniffed window.
const ZIP_SIGNATURE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function deps(overrides: Partial<Parameters<typeof moderateUploadedFile>[0]> = {}) {
  return {
    userId: 'u1',
    fabFileId: 'fab1',
    mimeType: 'image/png',
    enabled: true,
    downloadBytes: vi.fn(async () => Buffer.from('img-bytes')),
    downloadPartialBytes: vi.fn(async () => PNG_SIGNATURE),
    moderateImageOrThrow: vi.fn(async () => {}), // clean by default
    incidents: { record: vi.fn(async () => ({})) },
    service: {} as any,
    logger,
    ...overrides,
  };
}

describe('moderateUploadedFile', () => {
  it('returns clean for a non-image without downloading the full object or scanning', async () => {
    const d = deps({ mimeType: 'application/pdf', downloadPartialBytes: vi.fn(async () => PDF_SIGNATURE) });
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('clean');
    expect(result.correctedMimeType).toBeUndefined();
    expect(d.downloadPartialBytes).toHaveBeenCalledOnce();
    expect(d.downloadBytes).not.toHaveBeenCalled();
    expect(d.moderateImageOrThrow).not.toHaveBeenCalled();
  });

  it('falls back to the declared mimeType when sniffing is inconclusive (no magic numbers detected)', async () => {
    const d = deps({
      mimeType: 'text/plain',
      downloadPartialBytes: vi.fn(async () => UNSNIFFABLE_BYTES),
    });
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('clean');
    expect(result.correctedMimeType).toBeUndefined();
    expect(d.downloadBytes).not.toHaveBeenCalled();
  });

  it('keeps a declared OOXML mimeType when a partial read only sniffs the generic zip container', async () => {
    // xlsx/docx/pptx are ZIP containers; a partial sniff sees `application/zip`. That generic
    // type must NOT clobber the declared OOXML subtype (else viewers / AI-editing break).
    const d = deps({ mimeType: XLSX_MIME, downloadPartialBytes: vi.fn(async () => ZIP_SIGNATURE) });
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('clean');
    expect(result.correctedMimeType).toBeUndefined(); // declared XLSX preserved, not corrected to zip
    expect(d.downloadBytes).not.toHaveBeenCalled(); // treated as non-image, no full scan
  });

  it('still corrects to application/zip for a non-OOXML declared type that sniffs as zip', async () => {
    // The OOXML preservation is scoped: a genuine zip declared as something else is still corrected.
    const d = deps({ mimeType: 'image/png', downloadPartialBytes: vi.fn(async () => ZIP_SIGNATURE) });
    const result = await moderateUploadedFile(d);
    expect(result.correctedMimeType).toBe('application/zip');
    expect(d.downloadBytes).not.toHaveBeenCalled(); // zip is non-image, so no scan
  });

  it('returns clean when an image scans clean', async () => {
    const d = deps();
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('clean');
    expect(d.downloadBytes).toHaveBeenCalledOnce();
    expect(d.moderateImageOrThrow).toHaveBeenCalledOnce();
  });

  it('returns blocked when the scan throws a confirmed ImageModerationBlockedError', async () => {
    const d = deps({
      moderateImageOrThrow: vi.fn(async () => {
        throw new ImageModerationBlockedError([{ name: 'Explicit', parentName: '', confidence: 99 }]);
      }),
    });
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('blocked');
    expect(result.blockReason).toBeUndefined();
  });

  it('rethrows (does not return blocked) when the scan throws a non-block, non-format transient error', async () => {
    // Transient failures (detector unavailable, download failure, throttling) must NOT be
    // mapped to a permanent 'blocked' status - they should propagate so the S3 event retries.
    const d = deps({
      moderateImageOrThrow: vi.fn(async () => {
        throw new Error('Rekognition unavailable after 3 attempts');
      }),
    });
    await expect(moderateUploadedFile(d)).rejects.toThrow('Rekognition unavailable after 3 attempts');
  });

  it('returns clean and skips scanning when moderation is disabled', async () => {
    const d = deps({ enabled: false });
    const result = await moderateUploadedFile(d);
    expect(result.moderationStatus).toBe('clean');
    expect(d.moderateImageOrThrow).not.toHaveBeenCalled();
    expect(d.downloadPartialBytes).not.toHaveBeenCalled();
  });

  describe('anti-spoof byte sniffing', () => {
    it('treats a file with a spoofed non-image declared mimeType but real image bytes as an image', async () => {
      const d = deps({
        mimeType: 'application/pdf', // attacker-declared to dodge the scan
        downloadPartialBytes: vi.fn(async () => PNG_SIGNATURE), // real PNG magic bytes
      });
      const result = await moderateUploadedFile(d);
      expect(result.moderationStatus).toBe('clean');
      // It WAS treated as an image: full bytes fetched and the gate invoked.
      expect(d.downloadBytes).toHaveBeenCalledOnce();
      expect(d.moderateImageOrThrow).toHaveBeenCalledOnce();
      expect(d.moderateImageOrThrow).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png' }));
      // The corrected (sniffed) mime is surfaced for the caller to persist onto FabFile.
      expect(result.correctedMimeType).toBe('image/png');
    });

    it('does not correct mimeType when the sniffed type matches the declared type', async () => {
      const d = deps({ mimeType: 'image/png', downloadPartialBytes: vi.fn(async () => PNG_SIGNATURE) });
      const result = await moderateUploadedFile(d);
      expect(result.correctedMimeType).toBeUndefined();
    });

    it('a declared-image file that is actually a non-image is not scanned, and mime is corrected', async () => {
      const d = deps({
        mimeType: 'image/png', // declared image
        downloadPartialBytes: vi.fn(async () => PDF_SIGNATURE), // but really a PDF
      });
      const result = await moderateUploadedFile(d);
      expect(result.moderationStatus).toBe('clean');
      expect(d.downloadBytes).not.toHaveBeenCalled();
      expect(d.moderateImageOrThrow).not.toHaveBeenCalled();
      expect(result.correctedMimeType).toBe('application/pdf');
    });
  });

  describe('unsupported image formats', () => {
    it('reaches a terminal "blocked" (not a retryable throw) when the format cannot be scanned', async () => {
      const d = deps({
        moderateImageOrThrow: vi.fn(async () => {
          throw new UnsupportedImageFormatError('Rekognition rejected the format and jimp could not transcode it');
        }),
      });
      const result = await moderateUploadedFile(d);
      expect(result.moderationStatus).toBe('blocked');
      expect(result.blockReason).toBe('unsupported_format');
    });

    it('still rethrows a genuine transient error rather than collapsing it into unsupported_format', async () => {
      const d = deps({
        moderateImageOrThrow: vi.fn(async () => {
          throw new Error('ThrottlingException');
        }),
      });
      await expect(moderateUploadedFile(d)).rejects.toThrow('ThrottlingException');
    });

    it.each(['image/jpeg', 'image/png', 'image/webp'])('%s still scans normally when clean', async mimeType => {
      const d = deps({ mimeType, downloadPartialBytes: vi.fn(async () => PNG_SIGNATURE) });
      const result = await moderateUploadedFile(d);
      expect(result.moderationStatus).toBe('clean');
      expect(d.moderateImageOrThrow).toHaveBeenCalledOnce();
    });
  });
});

describe('isTerminalModerationStatus (terminal-state guard)', () => {
  it('is terminal for "clean" and "blocked" — must not be re-scanned on S3 redelivery', () => {
    expect(isTerminalModerationStatus('clean')).toBe(true);
    expect(isTerminalModerationStatus('blocked')).toBe(true);
  });

  it('is NOT terminal for "pending" or unset — those must still be scanned', () => {
    expect(isTerminalModerationStatus('pending')).toBe(false);
    expect(isTerminalModerationStatus(undefined)).toBe(false);
  });
});
