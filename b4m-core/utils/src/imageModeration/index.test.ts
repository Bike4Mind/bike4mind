import { randomBytes, randomFillSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { imageSize } from 'image-size';
import {
  ImageTooLargeException,
  InvalidImageFormatException,
  InvalidParameterException,
  ProvisionedThroughputExceededException,
} from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';
import {
  RekognitionImageModerationService,
  ImageModerationBlockedError,
  ModerationUnavailableError,
  isThrottlingError,
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

  describe('throttling', () => {
    const throttle = () =>
      new ProvisionedThroughputExceededException({ message: 'Provisioned rate exceeded', $metadata: {} });
    const quietLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

    it('backs off and recovers from a throttle burst without logging a warning', async () => {
      let call = 0;
      const client = fakeClient(async () => {
        if (++call <= 4) throw throttle();
        return { ModerationLabels: [] };
      });
      const sleep = vi.fn(async () => {});
      const logger = quietLogger();
      const svc = new RekognitionImageModerationService(logger, client, { sleep });

      await expect(svc.checkImage(buf, 'image/png')).resolves.toBeUndefined();

      // 4 throttles is past the generic 3-attempt budget, so this only passes on the throttle budget.
      expect(client.send).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);
      // Full jitter under an exponentially growing ceiling: 200, 400, 800, 1600ms.
      sleep.mock.calls.forEach(([ms], i) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(200 * 2 ** i);
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('fails closed with a throttled ModerationUnavailableError once the throttle budget is spent', async () => {
      const client = fakeClient(async () => {
        throw throttle();
      });
      const sleep = vi.fn(async () => {});
      const svc = new RekognitionImageModerationService(quietLogger(), client, { sleep });

      const caught = await svc.checkImage(buf, 'image/png').catch((err: unknown) => err);

      expect(caught).toBeInstanceOf(ModerationUnavailableError);
      expect((caught as ModerationUnavailableError).throttled).toBe(true);
      expect((caught as Error).message).toContain('Provisioned rate exceeded');
      expect(client.send).toHaveBeenCalledTimes(6);
      // No sleep after the final attempt, and every wait stays under the cap.
      expect(sleep).toHaveBeenCalledTimes(5);
      for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThan(3000);
    });

    it('keeps the shorter budget, and a warning, for a non-throttle transient error', async () => {
      const client = fakeClient(async () => {
        throw new Error('ServiceUnavailable');
      });
      const sleep = vi.fn(async () => {});
      const logger = quietLogger();
      const svc = new RekognitionImageModerationService(logger, client, { sleep });

      const caught = await svc.checkImage(buf, 'image/png').catch((err: unknown) => err);

      expect(caught).toBeInstanceOf(ModerationUnavailableError);
      expect((caught as ModerationUnavailableError).throttled).toBe(false);
      expect(client.send).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('recognizes throttles by SDK error name or retryable flag', () => {
      expect(isThrottlingError(throttle())).toBe(true);
      expect(isThrottlingError(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe(true);
      expect(isThrottlingError(Object.assign(new Error('x'), { $retryable: { throttling: true } }))).toBe(true);
      expect(isThrottlingError(new Error('ServiceUnavailable'))).toBe(false);
      expect(isThrottlingError(invalidImageFormatError())).toBe(false);
    });
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

  describe('images over the provider dimension limit', () => {
    it('downscales a byte-small image taller than 10000px before scanning it', async () => {
      const { Jimp } = await import('jimp');
      // Solid color: about 100 KB on disk, far under the byte budget, 21.8 MP so under the bomb guard.
      const tall = Buffer.from(
        await new Jimp({ width: 1960, height: 11139, color: 0xff0000ff }).getBuffer('image/png')
      );
      expect(tall.length).toBeLessThan(MAX_INLINE_IMAGE_BYTES);

      let sentBytes: Buffer | undefined;
      const client = {
        send: vi.fn(async (command: { input: { Image?: { Bytes?: Uint8Array } } }) => {
          sentBytes = Buffer.from(command.input.Image!.Bytes!);
          return { ModerationLabels: [] };
        }),
      } as unknown as import('@aws-sdk/client-rekognition').RekognitionClient;
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      await expect(svc.checkImage(tall, 'image/png')).resolves.toBeUndefined();
      expect(client.send).toHaveBeenCalledTimes(1);
      const { width, height } = imageSize(sentBytes!);
      expect(Math.max(width!, height!)).toBeLessThanOrEqual(10000);
    });

    it.each([
      ['ImageTooLargeException', ImageTooLargeException],
      ['InvalidParameterException', InvalidParameterException],
    ])('treats %s as terminal instead of retrying', async (_name, Exc) => {
      const client = fakeClient(async () => {
        throw new Exc({ message: 'exceed maximum dimension size of 10000 pixels', $metadata: {} });
      });
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);

      await expect(svc.checkImage(REAL_PNG, 'image/png')).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      expect(client.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('pixel-bomb guard', () => {
    // A valid PNG header declaring width x height, padded past the inline threshold (unless pad is
    // false) so fitForInlineDetection reaches the decode branch. image-size reads the IHDR without
    // decoding, standing in for a compressible file that declares a huge canvas.
    function oversizedHugeDimsPng(width: number, height: number, pad = true): Buffer {
      const head = Buffer.alloc(33);
      head.write('89504e470d0a1a0a', 0, 'hex');
      head.writeUInt32BE(13, 8);
      head.write('IHDR', 12, 'ascii');
      head.writeUInt32BE(width, 16);
      head.writeUInt32BE(height, 20);
      head.writeUInt8(8, 24);
      head.writeUInt8(6, 25);
      return pad ? Buffer.concat([head, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1024 - head.length)]) : head;
    }

    it('fails closed on an oversized image declaring more pixels than the decode budget, before any Rekognition call', async () => {
      const client = fakeClient(async () => ({ ModerationLabels: [] }));
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
      const bomb = oversizedHugeDimsPng(20000, 20000); // 4e8 px, well over the 60 MP budget
      await expect(svc.checkImage(bomb, 'image/png')).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      await expect(svc.checkImage(bomb, 'image/png')).rejects.toThrow(/decode limit/);
      expect(client.send).not.toHaveBeenCalled(); // rejected before the bitmap is materialized
    });

    it('fails closed on a byte-small image that reaches the decode branch only via the dimension trigger', async () => {
      const client = fakeClient(async () => ({ ModerationLabels: [] }));
      const svc = new RekognitionImageModerationService(Logger.globalInstance, client);
      const bomb = oversizedHugeDimsPng(7000, 12000, false); // 84 MP, tall, header-only so under the byte budget
      expect(bomb.length).toBeLessThan(MAX_INLINE_IMAGE_BYTES);
      await expect(svc.checkImage(bomb, 'image/png')).rejects.toBeInstanceOf(UnsupportedImageFormatError);
      await expect(svc.checkImage(bomb, 'image/png')).rejects.toThrow(/decode limit/);
      expect(client.send).not.toHaveBeenCalled();
    });
  });
});

describe('RekognitionImageModerationService without an injected logger', () => {
  it('logs to the Logger.globalInstance active at call time, not at construction', async () => {
    const svc = new RekognitionImageModerationService(
      undefined,
      fakeClient(async () => {
        throw new Error('ServiceUnavailable');
      })
    );
    const requestLogger = new Logger();
    const warn = vi.spyOn(requestLogger, 'warn').mockImplementation(() => {});
    Logger.setContextProvider(() => requestLogger);
    try {
      await expect(svc.checkImage(buf, 'image/png')).rejects.toThrow('ServiceUnavailable');
    } finally {
      Logger.setContextProvider(undefined);
    }
    expect(warn).toHaveBeenCalled();
  });
});
