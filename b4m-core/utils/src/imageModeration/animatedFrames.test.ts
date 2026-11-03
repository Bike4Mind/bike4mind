import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import {
  type DetectModerationLabelsCommand,
  ProvisionedThroughputExceededException,
  type RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';
import { extractAnimationFrames } from './animatedFrames';
import {
  EXPLICIT_NUDITY_CONFIDENCE,
  ImageModerationBlockedError,
  ModerationUnavailableError,
  RekognitionImageModerationService,
  UnsupportedImageFormatError,
} from './index';

// Encoded by Pillow, an independent encoder, with the real-world delta encoding: after the first
// frame each frame only covers the region that changed. Frames are white, then the top half red,
// then the bottom half red, so only the composite of the last frame is fully red.
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

// Newer Node versions pool Buffers up to 32 KiB, which puts the fixtures' 64x64 canvases in the
// shared pool; pin that size so a pooled-buffer bug shows on every Node version.
const originalPoolSize = Buffer.poolSize;
beforeAll(() => {
  Buffer.poolSize = 65536;
});
afterAll(() => {
  Buffer.poolSize = originalPoolSize;
});

const isRed = (rgba: number) => {
  const { r, g, b } = { r: (rgba >>> 24) & 0xff, g: (rgba >>> 16) & 0xff, b: (rgba >>> 8) & 0xff };
  return r > 200 && g < 60 && b < 60;
};
const fullyRed = async (bytes: Buffer) => {
  const image = await Jimp.read(bytes);
  return isRed(image.getPixelColor(5, 5)) && isRed(image.getPixelColor(5, 50));
};

// Flags an image only when the whole canvas is red, which no single frame region of the fixtures is.
const flagFullyRed = () => {
  const send = vi.fn(async (command: DetectModerationLabelsCommand) => {
    const red = await fullyRed(Buffer.from(command.input.Image!.Bytes!)).catch(() => false);
    return {
      ModerationLabels: red ? [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE + 1 }] : [],
    };
  });
  return {
    send,
    service: new RekognitionImageModerationService(Logger.globalInstance, { send } as unknown as RekognitionClient),
  };
};

describe('extractAnimationFrames', () => {
  it.each(['tiles.gif', 'tiles.png'])('composites each %s frame the way a viewer shows it', async name => {
    const frames = await extractAnimationFrames(fixture(name));

    expect(frames).toHaveLength(3);
    expect(await fullyRed(frames![1])).toBe(false);
    expect(await fullyRed(frames![2])).toBe(true);
  });

  it('splits an all-keyframe animated WebP into standalone WebP frames', async () => {
    const frames = await extractAnimationFrames(fixture('keyframes.webp'));

    expect(frames).toHaveLength(3);
    for (const frame of frames!) {
      expect(frame.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(frame.readUInt32LE(4)).toBe(frame.length - 8);
      expect(frame.subarray(8, 16).toString('latin1')).toBe('WEBPVP8X');
    }
  });

  it('refuses an animated WebP with partial frames, which it cannot composite', async () => {
    await expect(extractAnimationFrames(fixture('delta.webp'))).rejects.toThrow(UnsupportedImageFormatError);
  });

  it('refuses more frames than the cap', async () => {
    await expect(extractAnimationFrames(fixture('over-cap.gif'))).rejects.toThrow(/61 frames, over the 60 cap/);
  });

  it('refuses a malformed APNG as unsupported rather than as a retryable error', async () => {
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const apng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.alloc(2)), // short: no room for the width and height
      chunk('acTL', Buffer.alloc(8)),
      chunk('fcTL', Buffer.alloc(26)),
      chunk('fcTL', Buffer.alloc(26)),
      chunk('IEND', Buffer.alloc(0)),
    ]);

    await expect(extractAnimationFrames(apng)).rejects.toThrow(UnsupportedImageFormatError);
  });

  it('leaves still images to the single-image path', async () => {
    const still = await new Jimp({ width: 4, height: 4, color: 0xffffffff }).getBuffer('image/png');
    expect(await extractAnimationFrames(Buffer.from(still))).toBeNull();
    expect(await extractAnimationFrames(Buffer.from('not an image'))).toBeNull();
  });
});

describe('RekognitionImageModerationService.checkImage - animated images', () => {
  it.each(['tiles.gif', 'tiles.png'])('blocks a %s whose explicit frame only exists after the first', async name => {
    const { service } = flagFullyRed();

    await expect(service.checkImage(fixture(name), 'image/gif')).rejects.toThrow(ImageModerationBlockedError);
  });

  it('blocks an APNG whose separate fallback poster is flagged while every animation frame is clean', async () => {
    // Encoded independently with Python's struct/zlib: red default IDAT image, then two white
    // animation frames. Its first fcTL follows IDAT, so the poster is not animation frame 0.
    const bytes = fixture('fallback-poster.png');
    // APNG-unaware viewers show the original IDAT poster. Only that image is flagged; the
    // animation itself is clean, so omitting the poster from moderation must fail this test.
    const send = vi.fn(async (command: DetectModerationLabelsCommand) => ({
      ModerationLabels: Buffer.from(command.input.Image!.Bytes!).equals(bytes)
        ? [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE + 1 }]
        : [],
    }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);

    await expect(service.checkImage(bytes, 'image/png')).rejects.toThrow(ImageModerationBlockedError);
    expect(send.mock.calls.some(([command]) => Buffer.from(command.input.Image!.Bytes!).equals(bytes))).toBe(true);

    const frames = await extractAnimationFrames(bytes);
    expect(frames).toHaveLength(3);
    expect(frames![0]).toEqual(bytes);
    for (const frame of frames!.slice(1)) {
      expect(await fullyRed(frame)).toBe(false);
    }
  });

  it('blocks an animated WebP when only a later frame is flagged', async () => {
    const flagged = (await extractAnimationFrames(fixture('keyframes.webp')))![2];
    const send = vi.fn(async (command: DetectModerationLabelsCommand) => ({
      ModerationLabels: Buffer.from(command.input.Image!.Bytes!).equals(flagged)
        ? [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE + 1 }]
        : [],
    }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);

    await expect(service.checkImage(fixture('keyframes.webp'), 'image/webp')).rejects.toThrow(
      ImageModerationBlockedError
    );
  });

  it.each(['over-cap.gif', 'delta.webp'])('blocks %s as unsupported without calling Rekognition', async name => {
    const { send, service } = flagFullyRed();

    await expect(service.checkImage(fixture(name), 'image/gif')).rejects.toThrow(UnsupportedImageFormatError);
    expect(send).not.toHaveBeenCalled();
  });

  it('passes an animation whose frames are all clean, scanning every one', async () => {
    const send = vi.fn(async () => ({ ModerationLabels: [] }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);

    await expect(service.checkImage(fixture('tiles.png'), 'image/png')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('fails closed once backoff summed across frames would pass the per-image deadline', async () => {
    // Each frame throttles twice then succeeds: inside its own attempt budget, so only the shared
    // deadline can stop the scan.
    const calls = new Map<string, number>();
    const send = vi.fn(async (command: DetectModerationLabelsCommand) => {
      const key = Buffer.from(command.input.Image!.Bytes!).toString('base64');
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      if (n <= 2) throw new ProvisionedThroughputExceededException({ message: 'Rate exceeded', $metadata: {} });
      return { ModerationLabels: [] };
    });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const service = new RekognitionImageModerationService(
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      { send } as unknown as RekognitionClient,
      { sleep, deadlineMs: 1000 }
    );

    try {
      // One frame alone sleeps ~594 ms (198 + 396), so all three frames cannot fit in 1000 ms.
      await expect(service.checkImage(fixture('tiles.png'), 'image/png')).rejects.toThrow(ModerationUnavailableError);
      expect(now).toBeLessThanOrEqual(1000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
