import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import { normalizeEditMask, withProviderMask } from './editMask';
import type { ImageInputs } from './types';

const BLACK = 0x000000ff;
const WHITE = 0xffffffff;
const CLEAR = 0x00000000;

const png = async (width: number, height: number, pixelAt: (x: number) => number) => {
  const image = new Jimp({ width, height, color: BLACK });
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) image.setPixelColor(pixelAt(x), x, y);
  return Buffer.from(await image.getBuffer('image/png'));
};

// [r, g, b, a] at (x, 0).
const rgbaAt = async (bytes: Buffer, x: number) => {
  const image = await Jimp.read(bytes);
  const offset = x * 4;
  return [...image.bitmap.data.subarray(offset, offset + 4)];
};

const sizeOf = async (bytes: Buffer) => {
  const { width, height } = (await Jimp.read(bytes)).bitmap;
  return { width, height };
};

describe('normalizeEditMask', () => {
  // Left half white (change), right half black (keep), drawn at half the source's size.
  const drawnMask = () => png(2, 1, x => (x === 0 ? WHITE : BLACK));
  const source = () => png(4, 2, () => BLACK);

  it('turns a white-on-black mask into OpenAI transparency at the source size', async () => {
    const out = await normalizeEditMask(await drawnMask(), await source(), 'transparent');
    expect(await sizeOf(out)).toEqual({ width: 4, height: 2 });
    expect((await rgbaAt(out, 0))[3]).toBe(0);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('keeps a white-on-black mask white-on-black for BFL', async () => {
    const out = await normalizeEditMask(await drawnMask(), await source(), 'white');
    expect(await rgbaAt(out, 0)).toEqual([255, 255, 255, 255]);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('reads a mask with transparency as transparent = change, whatever its colours', async () => {
    const alphaMask = await png(4, 2, x => (x < 2 ? CLEAR : WHITE));
    const out = await normalizeEditMask(alphaMask, await source(), 'white');
    expect(await rgbaAt(out, 0)).toEqual([255, 255, 255, 255]);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('refuses a mask it cannot decode', async () => {
    await expect(normalizeEditMask(Buffer.from('not an image'), await source(), 'white')).rejects.toThrow(
      'The mask image could not be read'
    );
  });
});

describe('withProviderMask', () => {
  it('passes inputs without a mask through untouched', async () => {
    const inputs: ImageInputs = { images: [{ role: 'edit_source', bytes: Buffer.from('x'), mimeType: 'image/png' }] };
    expect(await withProviderMask(inputs, 'transparent')).toBe(inputs);
  });

  it('replaces only the mask, as a PNG', async () => {
    const sourceBytes = await png(2, 1, () => BLACK);
    const reference = { role: 'reference' as const, bytes: Buffer.from('ref'), mimeType: 'image/webp' };
    const inputs: ImageInputs = {
      images: [
        { role: 'edit_source', bytes: sourceBytes, mimeType: 'image/png' },
        { role: 'mask', bytes: await png(2, 1, x => (x === 0 ? WHITE : BLACK)), mimeType: 'image/jpeg' },
        reference,
      ],
    };
    const out = await withProviderMask(inputs, 'transparent');
    const images = out.images ?? [];
    expect(images[0].bytes).toBe(sourceBytes);
    expect(images[1].mimeType).toBe('image/png');
    expect((await rgbaAt(images[1].bytes, 0))[3]).toBe(0);
    expect(images[2]).toBe(reference);
  });
});
