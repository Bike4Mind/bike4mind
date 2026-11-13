import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import {
  applyCutoutMatte,
  CutoutMatteMismatchError,
  CutoutSourceError,
  cutoutCanvasSizeFor,
  cutoutFitsPixelBudget,
  padForMatte,
  readImageDimensions,
} from './imageCutout';

// A 300x200 source whose every pixel differs, so a re-rendered or shifted pixel cannot pass as the original.
const makeSource = async (): Promise<Buffer> => {
  const image = new Jimp({ width: 300, height: 200, color: 0x000000ff });
  image.scan((x, y, index) => {
    image.bitmap.data[index] = x % 256;
    image.bitmap.data[index + 1] = y % 256;
    image.bitmap.data[index + 2] = (x * 7 + y * 3) % 256;
    image.bitmap.data[index + 3] = 255;
  });
  return Buffer.from(await image.getBuffer('image/png'));
};

// A matte for a 3:2 canvas: opaque on its left half, transparent on its right half.
const makeMatte = async (width: number, height: number): Promise<Buffer> => {
  const image = new Jimp({ width, height, color: 0xffffffff });
  image.scan((x, _y, index) => {
    image.bitmap.data[index + 3] = x < width / 2 ? 255 : 0;
  });
  return Buffer.from(await image.getBuffer('image/png'));
};

const solid = async (width: number, height: number): Promise<Buffer> =>
  Buffer.from(await new Jimp({ width, height, color: 0x336699ff }).getBuffer('image/png'));

const matteWith = async (width: number, height: number, alphaAt: (x: number, y: number) => number): Promise<Buffer> => {
  const image = new Jimp({ width, height, color: 0xffffffff });
  image.scan((x, y, index) => {
    image.bitmap.data[index + 3] = alphaAt(x, y);
  });
  return Buffer.from(await image.getBuffer('image/png'));
};

// A JPEG with an APP1 EXIF segment carrying orientation 6 spliced in after the SOI marker.
const jpegWithOrientation6 = async (width: number, height: number): Promise<Buffer> => {
  const jpeg = Buffer.from(await new Jimp({ width, height, color: 0xff0000ff }).getBuffer('image/jpeg'));
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
};

describe('cutoutCanvasSizeFor', () => {
  it('picks the canvas closest to the source aspect', () => {
    expect(cutoutCanvasSizeFor({ width: 3000, height: 2000 })).toBe('1536x1024');
    expect(cutoutCanvasSizeFor({ width: 1200, height: 1800 })).toBe('1024x1536');
    expect(cutoutCanvasSizeFor({ width: 1000, height: 1050 })).toBe('1024x1024');
  });
});

describe('cutoutFitsPixelBudget', () => {
  it('budgets the padded canvas, not the source', () => {
    expect(cutoutFitsPixelBudget({ width: 6000, height: 4000 }, '1536x1024')).toBe(true);
    // 60MP of source, padded out to 30000x20000.
    expect(cutoutFitsPixelBudget({ width: 30_000, height: 2_000 }, '1536x1024')).toBe(false);
  });
});

describe('padForMatte', () => {
  it('scales the padded source to the requested canvas', async () => {
    const padded = await padForMatte(await makeSource(), '1536x1024');
    expect(readImageDimensions(padded)).toEqual({ width: 1536, height: 1024 });
  });

  it('refuses bytes it cannot read', async () => {
    await expect(padForMatte(Buffer.from('not an image'), '1024x1024')).rejects.toBeInstanceOf(CutoutSourceError);
  });
});

describe('applyCutoutMatte', () => {
  it('keeps every source pixel and takes only the matte alpha', async () => {
    const source = await makeSource();
    const cutout = await applyCutoutMatte(source, await makeMatte(1536, 1024), '1536x1024');

    const original = await Jimp.read(source);
    const result = await Jimp.read(cutout);
    expect(result.bitmap.width).toBe(300);
    expect(result.bitmap.height).toBe(200);
    for (let index = 0; index < original.bitmap.data.length; index += 4) {
      // The label stays untouched: RGB is byte-identical to the source.
      expect(result.bitmap.data.subarray(index, index + 3)).toEqual(original.bitmap.data.subarray(index, index + 3));
    }
    const alphaAt = (x: number, y: number) => result.bitmap.data[(y * 300 + x) * 4 + 3];
    expect(alphaAt(10, 100)).toBe(255);
    expect(alphaAt(290, 100)).toBe(0);
  });

  it('refuses a fully opaque matte', async () => {
    await expect(
      applyCutoutMatte(await makeSource(), await matteWith(1536, 1024, () => 255), '1536x1024')
    ).rejects.toThrow(CutoutMatteMismatchError);
  });

  it('refuses a fully transparent matte', async () => {
    await expect(
      applyCutoutMatte(await makeSource(), await matteWith(1536, 1024, () => 0), '1536x1024')
    ).rejects.toThrow(CutoutMatteMismatchError);
  });

  it('crops the padding off the matte horizontally for a source narrower than the canvas', async () => {
    // 300x260 pads to a 390x260 canvas: 45px of padding each side. Opaque from canvas x 50 to 200 (matte x 197 to 788).
    const matte = await matteWith(1536, 1024, x => (x >= 197 && x < 788 ? 255 : 0));
    const result = await Jimp.read(await applyCutoutMatte(await solid(300, 260), matte, '1536x1024'));
    expect(result.bitmap.width).toBe(300);
    expect(result.bitmap.height).toBe(260);
    const alphaAt = (x: number, y: number) => result.bitmap.data[(y * 300 + x) * 4 + 3];
    expect(alphaAt(10, 130)).toBe(255);
    expect(alphaAt(140, 130)).toBe(255);
    expect(alphaAt(170, 130)).toBe(0);
    expect(alphaAt(290, 130)).toBe(0);
  });

  it('crops the padding off the matte vertically for a source wider than the canvas', async () => {
    // 600x200 pads to a 600x400 canvas: 100px of padding top and bottom. Opaque from canvas y 110 down (matte y 282).
    const matte = await matteWith(1536, 1024, (_x, y) => (y >= 282 ? 255 : 0));
    const result = await Jimp.read(await applyCutoutMatte(await solid(600, 200), matte, '1536x1024'));
    expect(result.bitmap.width).toBe(600);
    expect(result.bitmap.height).toBe(200);
    const alphaAt = (x: number, y: number) => result.bitmap.data[(y * 600 + x) * 4 + 3];
    expect(alphaAt(300, 3)).toBe(0);
    expect(alphaAt(300, 50)).toBe(255);
    expect(alphaAt(300, 190)).toBe(255);
  });

  it('refuses a matte in another shape than the canvas it was asked for', async () => {
    await expect(applyCutoutMatte(await makeSource(), await makeMatte(1024, 1024), '1536x1024')).rejects.toBeInstanceOf(
      CutoutMatteMismatchError
    );
  });
});

describe('readImageDimensions', () => {
  it('swaps the sides of a JPEG with a quarter-turn EXIF orientation', async () => {
    expect(readImageDimensions(await jpegWithOrientation6(40, 20))).toEqual({ width: 20, height: 40 });
  });
});
