import { randomBytes, randomFillSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { InvalidImageFormatException } from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';
import {
  RekognitionImageModerationService,
  ImageModerationBlockedError,
  UnsupportedImageFormatError,
  EXPLICIT_NUDITY_CONFIDENCE,
} from './index';

// Mirrors the module's private `MAX_INLINE_IMAGE_BYTES` (not exported - it's an internal
// downscale threshold, not part of the service's public contract).
const MAX_INLINE_IMAGE_BYTES = 4.5 * 1024 * 1024;

/**
 * Random bytes are both incompressible (reliably `> MAX_INLINE_IMAGE_BYTES` as raw bytes,
 * unlike e.g. a solid-color image which would compress away) and have no recognizable image
 * magic number, so jimp's format sniff (`file-type`) fails to decode them - standing in for a
 * format jimp cannot read (e.g. HEIC from an iPhone) that also happens to be oversized.
 */
function oversizedUndecodableBuffer(): Buffer {
  return randomBytes(MAX_INLINE_IMAGE_BYTES + 1024);
}

/**
 * A real, valid, oversized (>4.5MB) PNG wider than the 2048px downscale target, filled with
 * random pixel data (incompressible, so the PNG encoding reliably lands above the inline
 * threshold instead of compressing away) so `fitForInlineDetection` exercises the genuine
 * decode -> resize -> re-encode-as-JPEG path, not a mock.
 */
async function oversizedDecodablePngBuffer(): Promise<Buffer> {
  const { Jimp } = await import('jimp');
  const width = 2200; // > 2048 so a real downscale (not an upscale) happens
  const height = 550; // keeps pixel count (and encode time) small while width alone exceeds 2048
  const image = new Jimp({ width, height, color: 0x000000ff });
  randomFillSync(image.bitmap.data);
  return Buffer.from(await image.getBuffer('image/png'));
}

/**
 * A real, valid 2x2 red PNG that jimp itself both sniffs (via `file-type`) AND fully
 * pixel-decodes - generated with `new Jimp({...}).getBuffer('image/png')` and
 * inlined so the test has no runtime dependency on jimp to produce its fixture. (Some
 * hand-rolled "minimal" PNGs pass magic-number/IHDR sniffing but fail jimp's stricter
 * pixel decoder with "unrecognised content at end of stream" - this one round-trips both.)
 */
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg==',
  'base64'
);

function invalidImageFormatError(message = 'Request has invalid image format') {
  return new InvalidImageFormatException({ message, $metadata: {} });
}

// Minimal fake matching the one method we call. `send` returns whatever the test queues.
function fakeClient(sendImpl: () => Promise<unknown>) {
  return { send: vi.fn(sendImpl) } as unknown as import('@aws-sdk/client-rekognition').RekognitionClient;
}

const buf = Buffer.from('fake-image-bytes');
const C = EXPLICIT_NUDITY_CONFIDENCE + 1;

// Real Rekognition Content Moderation v7 response shapes, captured from a live
// DetectModerationLabels call against the dev account (model v7.0). On real explicit
// content the API returns the full hierarchy path together: L1 `Explicit` (ParentName ''),
// L2 `Explicit Nudity` (ParentName 'Explicit'), and L3 parts (ParentName 'Explicit Nudity').
// These fixtures lock in that the filter matches the LIVE taxonomy, not a guessed string.

describe('RekognitionImageModerationService.checkImage', () => {
  it('blocks v7 explicit content (L1 "Explicit" + L2/L3 subtree returned together)', async () => {
    const client = fakeClient(async () => ({
      ModerationModelVersion: '7.0',
      ModerationLabels: [
        { Name: 'Explicit', ParentName: '', Confidence: C },
        { Name: 'Explicit Nudity', ParentName: 'Explicit', Confidence: C },
        { Name: 'Exposed Female Genitalia', ParentName: 'Explicit Nudity', Confidence: C },
      ],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
    await expect(svc.checkImage(buf, 'image/png')).rejects.toBeInstanceOf(ImageModerationBlockedError);
  });

  it('blocks v7 "Explicit Sexual Activity" under L1 "Explicit" (the branch the old filter missed)', async () => {
    // Explicit Sexual Activity / Sex Toys sit under L1 `Explicit` but NOT under `Explicit Nudity`.
    // The pre-fix filter (which only matched "Explicit Nudity") would have let these through.
    const client = fakeClient(async () => ({
      ModerationModelVersion: '7.0',
      ModerationLabels: [
        { Name: 'Explicit', ParentName: '', Confidence: C },
        { Name: 'Explicit Sexual Activity', ParentName: 'Explicit', Confidence: C },
      ],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
    await expect(svc.checkImage(buf, 'image/png')).rejects.toBeInstanceOf(ImageModerationBlockedError);
  });

  it('blocks v6 taxonomy where "Explicit Nudity" is the L1 (cross-version safety)', async () => {
    const client = fakeClient(async () => ({
      ModerationModelVersion: '6.1',
      ModerationLabels: [
        { Name: 'Explicit Nudity', ParentName: '', Confidence: C },
        { Name: 'Graphic Male Nudity', ParentName: 'Explicit Nudity', Confidence: C },
      ],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
    await expect(svc.checkImage(buf, 'image/png')).rejects.toBeInstanceOf(ImageModerationBlockedError);
  });

  it('carries the offending labels on the thrown error', async () => {
    const client = fakeClient(async () => ({
      ModerationLabels: [{ Name: 'Explicit', ParentName: '', Confidence: 99 }],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

    await svc.checkImage(buf, 'image/png').then(
      () => {
        throw new Error('should have thrown');
      },
      (e: ImageModerationBlockedError) => {
        expect(e.labels[0].name).toBe('Explicit');
        expect(e.labels[0].confidence).toBe(99);
      }
    );
  });

  it('passes a clean image (no moderation labels)', async () => {
    const client = fakeClient(async () => ({ ModerationLabels: [] }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

    await expect(svc.checkImage(buf, 'image/png')).resolves.toBeUndefined();
  });

  it('passes when the only label is below the confidence threshold', async () => {
    const client = fakeClient(async () => ({
      ModerationLabels: [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE - 5 }],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

    await expect(svc.checkImage(buf, 'image/png')).resolves.toBeUndefined();
  });

  it('passes non-blocked categories at high confidence (Violence, and the allowed mild-nudity L1s)', async () => {
    // `Non-Explicit Nudity of Intimate parts and Kissing` and `Swimwear or Underwear` are
    // SEPARATE v7 L1 categories - deliberately not blocked (the product allows mild content).
    const client = fakeClient(async () => ({
      ModerationModelVersion: '7.0',
      ModerationLabels: [
        { Name: 'Violence', ParentName: '', Confidence: 99 },
        { Name: 'Non-Explicit Nudity of Intimate parts and Kissing', ParentName: '', Confidence: 99 },
        { Name: 'Swimwear or Underwear', ParentName: '', Confidence: 99 },
      ],
    }));
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

    await expect(svc.checkImage(buf, 'image/png')).resolves.toBeUndefined();
  });

  it('fail-closed: throws (not ImageModerationBlockedError) when Rekognition keeps erroring', async () => {
    const client = fakeClient(async () => {
      throw new Error('ThrottlingException');
    });
    const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

    // Must reject - an unavailable detector must NOT be treated as clean.
    await expect(svc.checkImage(buf, 'image/png')).rejects.toBeTruthy();
  });

  describe('unsupported / unaccepted image formats', () => {
    it('transcodes to JPEG via jimp and retries when Rekognition rejects the format, then succeeds', async () => {
      let call = 0;
      const seenImageBytes: Buffer[] = [];
      const client = {
        send: vi.fn(async (command: { input: { Image?: { Bytes?: Uint8Array } } }) => {
          call++;
          seenImageBytes.push(Buffer.from(command.input.Image!.Bytes!));
          if (call === 1) throw invalidImageFormatError();
          return { ModerationLabels: [] };
        }),
      } as unknown as import('@aws-sdk/client-rekognition').RekognitionClient;

      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
      // REAL_PNG is jimp-decodable - Rekognition rejects it once, then the transcoded
      // JPEG bytes succeed on retry.
      await expect(svc.checkImage(REAL_PNG, 'image/png')).resolves.toBeUndefined();

      expect(client.send).toHaveBeenCalledTimes(2);
      // First call used the original bytes; second call used different (transcoded) bytes.
      expect(seenImageBytes[0].equals(REAL_PNG)).toBe(true);
      expect(seenImageBytes[1].equals(REAL_PNG)).toBe(false);
      // JPEG magic number (FF D8 FF) on the transcoded bytes.
      expect(seenImageBytes[1][0]).toBe(0xff);
      expect(seenImageBytes[1][1]).toBe(0xd8);
      expect(seenImageBytes[1][2]).toBe(0xff);
    });

    it('throws UnsupportedImageFormatError (terminal, not retried further) when jimp cannot decode the bytes either', async () => {
      // `buf` ("fake-image-bytes") is not a real image - jimp cannot decode it, mirroring an
      // unsupported format like HEIC/SVG that jimp also can't process.
      const client = fakeClient(async () => {
        throw invalidImageFormatError();
      });
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      await expect(svc.checkImage(buf, 'image/png')).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      // Terminal: exactly one Rekognition call - no transient-retry loop, no infinite retry.
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it('still retries and rethrows a genuine transient error (e.g. throttling) — not collapsed into unsupported_format', async () => {
      const client = fakeClient(async () => {
        throw new Error('ThrottlingException');
      });
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      let caught: unknown;
      try {
        await svc.checkImage(buf, 'image/png');
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeInstanceOf(UnsupportedImageFormatError);
      expect(caught).not.toBeInstanceOf(ImageModerationBlockedError);
      // Transient errors consume the full transient-retry budget (MAX_ATTEMPTS = 3) rather
      // than short-circuiting to a terminal block.
      expect(client.send).toHaveBeenCalledTimes(3);
    });
  });

  describe('oversized images crossing the 4.5MB inline limit (compound gap)', () => {
    it('terminal-blocks an oversized image jimp cannot decode, instead of falling through to Rekognition with the original oversized bytes', async () => {
      // Simulates the compound gap: oversized (triggers the proactive downscale attempt) AND
      // a format jimp cannot decode (e.g. HEIC) - before the fix this fell through with the
      // original bytes, which Rekognition would likely reject with `ImageTooLargeException`
      // (not `InvalidImageFormatException`, since it never gets far enough to see the format),
      // landing in the generic retry branch and getting stuck 'pending' until DLQ.
      const bytes = oversizedUndecodableBuffer();
      const client = fakeClient(async () => ({ ModerationLabels: [] }));
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      await expect(svc.checkImage(bytes, 'image/heic')).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      // Never reaches Rekognition at all: the decode failure is caught during proactive
      // downscaling, before the retry loop, so this must NOT burn the transient-retry budget.
      expect(client.send).not.toHaveBeenCalled();
    });

    it('still downscales and scans a normal oversized (but jimp-decodable) image', async () => {
      const original = await oversizedDecodablePngBuffer();
      expect(original.length).toBeGreaterThan(MAX_INLINE_IMAGE_BYTES);

      let sentBytes: Buffer | undefined;
      const client = {
        send: vi.fn(async (command: { input: { Image?: { Bytes?: Uint8Array } } }) => {
          sentBytes = Buffer.from(command.input.Image!.Bytes!);
          return { ModerationLabels: [] };
        }),
      } as unknown as import('@aws-sdk/client-rekognition').RekognitionClient;
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      await expect(svc.checkImage(original, 'image/png')).resolves.toBeUndefined();
      expect(client.send).toHaveBeenCalledTimes(1);
      // Downscaled/re-encoded bytes were sent to Rekognition, not the original oversized PNG.
      expect(sentBytes).toBeDefined();
      expect(sentBytes!.equals(original)).toBe(false);
      expect(sentBytes!.length).toBeLessThan(original.length);
      // JPEG magic number (FF D8 FF) confirms the re-encode-as-JPEG downscale path ran.
      expect(sentBytes![0]).toBe(0xff);
      expect(sentBytes![1]).toBe(0xd8);
      expect(sentBytes![2]).toBe(0xff);
    });

    it('still retries and rethrows a genuine transient Rekognition error for an oversized (downscaled) image', async () => {
      const original = await oversizedDecodablePngBuffer();
      const client = fakeClient(async () => {
        throw new Error('ServiceUnavailable');
      });
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      let caught: unknown;
      try {
        await svc.checkImage(original, 'image/png');
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeInstanceOf(UnsupportedImageFormatError);
      expect(caught).not.toBeInstanceOf(ImageModerationBlockedError);
      // Transient errors still consume the full transient-retry budget (MAX_ATTEMPTS = 3) -
      // the downscale path must not change retry semantics for genuine transient failures.
      expect(client.send).toHaveBeenCalledTimes(3);
    });
  });
});
