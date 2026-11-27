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
import { extractAnimationFrames, MAX_MODERATED_FRAMES } from './animatedFrames';
import {
  EXPLICIT_NUDITY_CONFIDENCE,
  ImageModerationBlockedError,
  ModerationBudgetExceededError,
  ModerationUnavailableError,
  RekognitionImageModerationService,
  UnsupportedImageFormatError,
} from './index';
import { jimpFromRgba } from './jimpBitmap';
import { decodeWebp, isWebp } from './webpDecode';

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

    // The poster, then one white frame: the second white frame repeats the first and is not rescanned.
    const frames = await extractAnimationFrames(bytes);
    expect(frames).toHaveLength(2);
    expect(frames![0]).toEqual(bytes);
    for (const frame of frames!.slice(1)) {
      expect(await fullyRed(frame)).toBe(false);
    }
  });

  it('blocks an animated WebP when only a later frame is flagged, sending each frame as JPEG', async () => {
    // Rekognition rejects WebP, so each frame reaches it as the JPEG transcode of that frame.
    const frame = (await extractAnimationFrames(fixture('keyframes.webp')))![2];
    const { data, width, height } = await decodeWebp(frame);
    const flagged = Buffer.from(await (await jimpFromRgba(data, width, height)).getBuffer('image/jpeg'));
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
    for (const [command] of send.mock.calls) expect(isWebp(Buffer.from(command.input.Image!.Bytes!))).toBe(false);
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

const range = (count: number) => Array.from({ length: count }, (_, i) => i);

// An 8x8 GIF of full-canvas frames; frame n shows the image of `sequence[n]`.
const countedGif = async (sequence: number[]) => {
  // @ts-expect-error omggif ships no type declarations
  const { GifWriter } = await import('omggif');
  const out = Buffer.alloc(64 * 1024);
  const palette = Array.from({ length: 64 }, (_, i) => frameRed(i) << 16);
  const writer = new GifWriter(out, 8, 8, { loop: 0, palette });
  for (const i of sequence) writer.addFrame(0, 0, 8, 8, new Uint8Array(64).fill(i), { disposal: 1 });
  return out.subarray(0, writer.end());
};

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC is not checked
};

// An 8x8 APNG of full-canvas frames, frame n showing the image of `sequence[n]`; with `poster`, a
// separate default image precedes them.
const countedApng = (sequence: number[], poster: boolean) => {
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
  actl.writeUInt32BE(sequence.length, 0);
  const fctl = () => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(8, 4);
    data.writeUInt32BE(8, 8);
    return pngChunk('fcTL', data);
  };
  const chunks = [pngChunk('IHDR', ihdr), pngChunk('acTL', actl)];
  if (poster) chunks.push(pngChunk('IDAT', pixels(250)));
  for (const [n, i] of sequence.entries()) {
    chunks.push(fctl());
    if (n === 0 && !poster) chunks.push(pngChunk('IDAT', pixels(frameRed(i))));
    else chunks.push(pngChunk('fdAT', Buffer.concat([Buffer.alloc(4), pixels(frameRed(i))])));
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
};

// keyframes.webp's three ANMF frames rearranged: frame n is its frame `sequence[n]`.
const sequencedWebp = (sequence: number[]) => {
  const bytes = fixture('keyframes.webp');
  const head: Buffer[] = [];
  const anmf: Buffer[] = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(p + 4);
    const chunk = bytes.subarray(p, p + 8 + size + (size & 1));
    (chunk.subarray(0, 4).toString('latin1') === 'ANMF' ? anmf : head).push(chunk);
    p += chunk.length;
  }
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...head, ...sequence.map(i => anmf[i])]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
};

const recordingService = (flagged?: (frameIndex: number) => boolean) => {
  const scanned: number[] = [];
  const send = vi.fn(async (command: DetectModerationLabelsCommand) => {
    const index = await frameIndexOf(Buffer.from(command.input.Image!.Bytes!));
    scanned.push(index);
    return {
      ModerationLabels: flagged?.(index)
        ? [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE + 1 }]
        : [],
    };
  });
  const service = new RekognitionImageModerationService(Logger.globalInstance, {
    send,
  } as unknown as RekognitionClient);
  return { send, service, scanned };
};

// keyframes.webp's own frames, as standalone WebP; a rearranged animation splits into these same bytes.
const webpKeyframes = async () => (await extractAnimationFrames(fixture('keyframes.webp')))!;

// The JPEG the detector receives for a WebP frame (Rekognition rejects WebP, so it is transcoded).
const detectorJpeg = async (webp: Buffer) => {
  const { data, width, height } = await decodeWebp(webp);
  return Buffer.from(await (await jimpFromRgba(data, width, height)).getBuffer('image/jpeg'));
};

describe('every distinct frame is moderated', () => {
  it('scans each frame of a 60-frame GIF and reserves one detector call per frame', async () => {
    const { send, service, scanned } = recordingService();
    const reserveDetectorCalls = vi.fn(async () => true);
    const onDetectorCall = vi.fn();

    await service.checkImage(await countedGif(range(MAX_MODERATED_FRAMES)), 'image/gif', {
      reserveDetectorCalls,
      onDetectorCall,
    });

    expect(reserveDetectorCalls).toHaveBeenCalledExactlyOnceWith(MAX_MODERATED_FRAMES);
    expect(send).toHaveBeenCalledTimes(MAX_MODERATED_FRAMES);
    expect(onDetectorCall).toHaveBeenCalledTimes(MAX_MODERATED_FRAMES);
    expect(scanned.sort((a, b) => a - b)).toEqual(range(MAX_MODERATED_FRAMES));
  });

  it.each([3, 30, 58])('blocks a 60-frame GIF when only frame %i is flagged', async flaggedFrame => {
    const { service } = recordingService(i => i === flaggedFrame);

    await expect(service.checkImage(await countedGif(range(60)), 'image/gif')).rejects.toThrow(
      ImageModerationBlockedError
    );
  });

  it.each([3, 30, 58])('blocks a 60-frame APNG when only frame %i is flagged', async flaggedFrame => {
    const { service } = recordingService(i => i === flaggedFrame);

    await expect(service.checkImage(countedApng(range(60), false), 'image/png')).rejects.toThrow(
      ImageModerationBlockedError
    );
  });

  it('blocks a 60-frame animated WebP when only one frame in the middle is flagged', async () => {
    const flagged = await detectorJpeg((await webpKeyframes())[2]);
    const send = vi.fn(async (command: DetectModerationLabelsCommand) => ({
      ModerationLabels: Buffer.from(command.input.Image!.Bytes!).equals(flagged)
        ? [{ Name: 'Explicit', ParentName: '', Confidence: EXPLICIT_NUDITY_CONFIDENCE + 1 }]
        : [],
    }));
    const service = new RekognitionImageModerationService(Logger.globalInstance, {
      send,
    } as unknown as RekognitionClient);
    // Frames alternate between the first two images; frame 32 alone shows the third.
    const sequence = range(60).map(n => (n === 32 ? 2 : n % 2));

    await expect(service.checkImage(sequencedWebp(sequence), 'image/webp')).rejects.toThrow(
      ImageModerationBlockedError
    );
  });

  it('keeps every frame of a 60-frame animated WebP whose consecutive frames differ', async () => {
    const keyframes = await webpKeyframes();
    const sequence = range(60).map(n => n % 3);
    const frames = await extractAnimationFrames(sequencedWebp(sequence));

    expect(frames).toEqual(sequence.map(i => keyframes[i]));
  });

  it('keeps every APNG frame after a separate default image, which is scanned too', async () => {
    const bytes = countedApng(range(59), true);
    const frames = await extractAnimationFrames(bytes);

    expect(frames).toHaveLength(60);
    expect(frames![0]).toEqual(bytes);
    expect(await Promise.all(frames!.slice(1).map(frameIndexOf))).toEqual(range(59));
  });
});

describe('frames identical to the last scanned frame', () => {
  // Runs of repeated images, ending on an image seen earlier but not just before.
  const sequence = [0, 0, 0, 1, 1, 2, 2, 2, 2, 0];
  const distinct = [0, 1, 2, 0];

  it('skips them in a GIF and spends no allowance on them', async () => {
    const { send, service, scanned } = recordingService();
    const reserveDetectorCalls = vi.fn(async () => true);
    const onDetectorCall = vi.fn();

    await service.checkImage(await countedGif(sequence), 'image/gif', { reserveDetectorCalls, onDetectorCall });

    expect(reserveDetectorCalls).toHaveBeenCalledExactlyOnceWith(distinct.length);
    expect(send).toHaveBeenCalledTimes(distinct.length);
    expect(onDetectorCall).toHaveBeenCalledTimes(distinct.length);
    expect(scanned.sort((a, b) => a - b)).toEqual([...distinct].sort((a, b) => a - b));
    expect(await Promise.all((await extractAnimationFrames(await countedGif(sequence)))!.map(frameIndexOf))).toEqual(
      distinct
    );
  });

  it('skips them in an APNG', async () => {
    const frames = await extractAnimationFrames(countedApng(sequence, false));

    expect(await Promise.all(frames!.map(frameIndexOf))).toEqual(distinct);
  });

  it('skips them in an animated WebP', async () => {
    const keyframes = await webpKeyframes();
    const frames = await extractAnimationFrames(sequencedWebp(sequence));

    expect(frames).toEqual(distinct.map(i => keyframes[i]));
  });

  it('scans a 60-frame animation of one repeated image once', async () => {
    const { send, service } = recordingService();
    const reserveDetectorCalls = vi.fn(async () => true);

    await service.checkImage(await countedGif(range(60).map(() => 5)), 'image/gif', { reserveDetectorCalls });

    expect(reserveDetectorCalls).toHaveBeenCalledExactlyOnceWith(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('asks the allowance only for the distinct frames and makes no call when it is declined', async () => {
    const { send, service } = recordingService();

    const error = await service
      .checkImage(await countedGif(sequence), 'image/gif', { reserveDetectorCalls: async () => false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModerationBudgetExceededError);
    expect((error as ModerationBudgetExceededError).calls).toBe(distinct.length);
    expect(send).not.toHaveBeenCalled();
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
