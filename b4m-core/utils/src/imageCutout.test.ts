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

  it('refuses a matte in another shape than the canvas it was asked for', async () => {
    await expect(applyCutoutMatte(await makeSource(), await makeMatte(1024, 1024), '1536x1024')).rejects.toBeInstanceOf(
      CutoutMatteMismatchError
    );
  });
});
