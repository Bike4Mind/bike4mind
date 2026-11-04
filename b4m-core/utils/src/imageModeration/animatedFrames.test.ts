import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import {
  type DetectModerationLabelsCommand,
  ProvisionedThroughputExceededException,
  type RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { Logger } from '@bike4mind/observability';
import { extractAnimationFrames, MAX_SAMPLED_FRAMES, sampleFrameIndices } from './animatedFrames';
import {
  EXPLICIT_NUDITY_CONFIDENCE,
  ImageModerationBlockedError,
  ModerationBudgetExceededError,
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

// Frame i is filled with red level i * 4, so a decoded frame's red channel says which frame it is.
const frameRed = (i: number) => i * 4;
const frameIndexOf = async (bytes: Buffer) => {
  const image = await Jimp.read(bytes);
  return Math.round(((image.getPixelColor(2, 2) >>> 24) & 0xff) / 4);
};

const countedGif = async (count: number) => {
  // @ts-expect-error omggif ships no type declarations
  const { GifWriter } = await import('omggif');
  const out = Buffer.alloc(64 * 1024);
  const palette = Array.from({ length: 64 }, (_, i) => frameRed(i) << 16);
  const writer = new GifWriter(out, 8, 8, { loop: 0, palette });
  for (let i = 0; i < count; i++) writer.addFrame(0, 0, 8, 8, new Uint8Array(64).fill(i), { disposal: 1 });
  return out.subarray(0, writer.end());
};

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC is not checked
};

// An 8x8 APNG of `count` full-canvas frames; with `poster`, a separate default image precedes them.
const countedApng = (count: number, poster: boolean) => {
  const pixels = (red: number) =>
    deflateSync(
      Buffer.concat(
        Array.from({ length: 8 }, () =>
          Buffer.concat([Buffer.from([0]), ...Array.from({ length: 8 }, () => Buffer.from([red, 0, 0, 255]))])
        )
      )
    );
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(count, 0);
  const fctl = () => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(8, 4);
    data.writeUInt32BE(8, 8);
    return pngChunk('fcTL', data);
  };
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('acTL', actl)];
  if (poster) chunks.push(pngChunk('IDAT', pixels(250)));
  for (let i = 0; i < count; i++) {
    chunks.push(fctl());
    if (i === 0 && !poster) chunks.push(pngChunk('IDAT', pixels(frameRed(i))));
    else chunks.push(pngChunk('fdAT', Buffer.concat([Buffer.alloc(4), pixels(frameRed(i))])));
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
};

// keyframes.webp with its ANMF frames repeated to `count` frames.
const repeatedWebp = (count: number) => {
  const bytes = fixture('keyframes.webp');
  const head: Buffer[] = [];
  const anmf: Buffer[] = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(p + 4);
    const chunk = bytes.subarray(p, p + 8 + size + (size & 1));
    (chunk.subarray(0, 4).toString('latin1') === 'ANMF' ? anmf : head).push(chunk);
    p += chunk.length;
  }
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    ...head,
    ...Array.from({ length: count }, (_, i) => anmf[i % anmf.length]),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
};

describe('sampleFrameIndices', () => {
  it.each([
    [1, [0]],
    [2, [0, 1]],
    [10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    [11, [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]],
    [60, [0, 7, 13, 20, 26, 33, 39, 46, 52, 59]],
  ])('picks evenly spaced frames of %i, first and last included, without duplicates', (count, expected) => {
    const indices = sampleFrameIndices(count);

    expect(indices).toEqual(expected);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(count - 1);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices.length).toBeLessThanOrEqual(MAX_SAMPLED_FRAMES);
  });

  it('honours an explicit cap', () => {
    expect(sampleFrameIndices(5, 3)).toEqual([0, 2, 4]);
  });
});

describe('frame sampling', () => {
  it('moderates only the sampled frames of a 60-frame GIF, composited in order', async () => {
    const send = vi.fn(async (_command: DetectModerationLabelsCommand) => ({ ModerationLabels: [] }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);
    const onDetectorCall = vi.fn();
    const reserveDetectorCalls = vi.fn(async () => true);

    await service.checkImage(await countedGif(60), 'image/gif', { reserveDetectorCalls, onDetectorCall });

    expect(send).toHaveBeenCalledTimes(MAX_SAMPLED_FRAMES);
    expect(reserveDetectorCalls).toHaveBeenCalledWith(MAX_SAMPLED_FRAMES);
    expect(onDetectorCall).toHaveBeenCalledTimes(MAX_SAMPLED_FRAMES);
    const scanned = await Promise.all(
      send.mock.calls.map(([command]) => frameIndexOf(Buffer.from(command.input.Image!.Bytes!)))
    );
    expect(scanned.sort((a, b) => a - b)).toEqual(sampleFrameIndices(60));
  });

  it('keeps every frame of a GIF at the sampling cap', async () => {
    const frames = await extractAnimationFrames(await countedGif(MAX_SAMPLED_FRAMES));

    expect(await Promise.all(frames!.map(frameIndexOf))).toEqual(sampleFrameIndices(MAX_SAMPLED_FRAMES));
  });

  it('samples an APNG, counting a separate default image as frame 0', async () => {
    const bytes = countedApng(20, true);
    const frames = await extractAnimationFrames(bytes);

    expect(frames).toHaveLength(MAX_SAMPLED_FRAMES);
    expect(frames![0]).toEqual(bytes);
    // Combined index k is animation frame k - 1.
    const expected = sampleFrameIndices(21)
      .slice(1)
      .map(k => k - 1);
    expect(await Promise.all(frames!.slice(1).map(frameIndexOf))).toEqual(expected);
  });

  it('samples an APNG whose default image is its first frame', async () => {
    const frames = await extractAnimationFrames(countedApng(30, false));

    expect(await Promise.all(frames!.map(frameIndexOf))).toEqual(sampleFrameIndices(30));
  });

  it('samples an animated WebP by picking frames', async () => {
    const frames = await extractAnimationFrames(repeatedWebp(25));

    expect(frames).toHaveLength(MAX_SAMPLED_FRAMES);
  });
});

describe('detector-call reservation', () => {
  const still = async () =>
    Buffer.from(await new Jimp({ width: 4, height: 4, color: 0xffffffff }).getBuffer('image/png'));

  it('reserves one call for a still image and reports it once made', async () => {
    const send = vi.fn(async () => ({ ModerationLabels: [] }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);
    const reserveDetectorCalls = vi.fn(async () => true);
    const onDetectorCall = vi.fn();

    await service.checkImage(await still(), 'image/png', { reserveDetectorCalls, onDetectorCall });

    expect(reserveDetectorCalls).toHaveBeenCalledWith(1);
    expect(onDetectorCall).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a still image', still, 1],
    ['an animation', () => Promise.resolve(fixture('tiles.gif')), 3],
  ])('refuses %s without a detector call when the reservation is declined', async (_what, bytes, calls) => {
    const send = vi.fn(async () => ({ ModerationLabels: [] }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);

    const error = await service
      .checkImage(await bytes(), 'image/png', { reserveDetectorCalls: async () => false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModerationBudgetExceededError);
    expect((error as ModerationBudgetExceededError).calls).toBe(calls);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report a call that failed', async () => {
    const send = vi.fn(async () => {
      throw new Error('boom');
    });
    const service = new RekognitionImageModerationService(
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      { send } as unknown as RekognitionClient,
      { sleep: async () => undefined }
    );
    const onDetectorCall = vi.fn();

    await expect(service.checkImage(await still(), 'image/png', { onDetectorCall })).rejects.toThrow(
      ModerationUnavailableError
    );
    expect(onDetectorCall).not.toHaveBeenCalled();
  });
});
