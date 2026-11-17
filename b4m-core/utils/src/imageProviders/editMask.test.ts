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
  const size = { width: 4, height: 2 };

  it('turns a white-on-black mask into OpenAI transparency at the source size', async () => {
    const out = await normalizeEditMask(await drawnMask(), size, 'transparent');
    expect(await sizeOf(out)).toEqual({ width: 4, height: 2 });
    expect((await rgbaAt(out, 0))[3]).toBe(0);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('keeps a white-on-black mask white-on-black for BFL', async () => {
    const out = await normalizeEditMask(await drawnMask(), size, 'white');
    expect(await rgbaAt(out, 0)).toEqual([255, 255, 255, 255]);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('reads a mask with transparency as transparent = change, whatever its colours', async () => {
    const alphaMask = await png(4, 2, x => (x < 2 ? CLEAR : WHITE));
    const out = await normalizeEditMask(alphaMask, size, 'white');
    expect(await rgbaAt(out, 0)).toEqual([255, 255, 255, 255]);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('stays a white mask when only a stray pixel is translucent', async () => {
    const nearlyOpaque = await png(40, 40, x => (x < 20 ? WHITE : BLACK));
    const image = await Jimp.read(nearlyOpaque);
    image.bitmap.data[3] = 0;
    const out = await normalizeEditMask(Buffer.from(await image.getBuffer('image/png')), size, 'white');
    expect(await rgbaAt(out, 1)).toEqual([255, 255, 255, 255]);
    expect(await rgbaAt(out, 3)).toEqual([0, 0, 0, 255]);
  });

  it('refuses a mask over the pixel budget before decoding it', async () => {
    // A PNG header (signature + IHDR) declaring 20000x20000; nothing past it is read.
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(20000, 16);
    header.writeUInt32BE(20000, 20);
    await expect(normalizeEditMask(header, size, 'white')).rejects.toThrow('pixel processing limit');
  });

  it('refuses a mask it cannot decode', async () => {
    await expect(normalizeEditMask(Buffer.from('not an image'), size, 'white')).rejects.toThrow(
      'The mask image could not be read'
    );
  });
});

describe('withProviderMask', () => {
  it('passes inputs without a mask through untouched', async () => {
    const inputs: ImageInputs = { images: [{ role: 'edit_source', bytes: Buffer.from('x'), mimeType: 'image/png' }] };
    expect(await withProviderMask(inputs, 'transparent')).toBe(inputs);
  });

  it('re-encodes a non-PNG source as PNG for OpenAI and sizes the mask to it', async () => {
    const jpeg = Buffer.from(await new Jimp({ width: 4, height: 2, color: BLACK }).getBuffer('image/jpeg'));
    const inputs: ImageInputs = {
      images: [
        { role: 'edit_source', bytes: jpeg, mimeType: 'image/jpeg' },
        { role: 'mask', bytes: await png(2, 1, x => (x === 0 ? WHITE : BLACK)), mimeType: 'image/png' },
      ],
    };
    const [source, mask] = (await withProviderMask(inputs, 'transparent')).images ?? [];
    expect(source.mimeType).toBe('image/png');
    expect(await sizeOf(source.bytes)).toEqual({ width: 4, height: 2 });
    expect(await sizeOf(mask.bytes)).toEqual({ width: 4, height: 2 });
  });

  it('leaves a non-PNG source alone for BFL', async () => {
    const jpeg = Buffer.from(await new Jimp({ width: 4, height: 2, color: BLACK }).getBuffer('image/jpeg'));
    const source = { role: 'edit_source' as const, bytes: jpeg, mimeType: 'image/jpeg' };
    const inputs: ImageInputs = {
      images: [source, { role: 'mask', bytes: await png(2, 1, () => WHITE), mimeType: 'image/png' }],
    };
    expect(((await withProviderMask(inputs, 'white')).images ?? [])[0]).toBe(source);
  });

  it('rejects an unreadable source as an input the provider never saw', async () => {
    const inputs: ImageInputs = {
      images: [
        { role: 'edit_source', bytes: Buffer.from('nope'), mimeType: 'image/png' },
        { role: 'mask', bytes: await png(2, 1, () => WHITE), mimeType: 'image/png' },
      ],
    };
    await expect(withProviderMask(inputs, 'white')).rejects.toMatchObject({
      name: 'ImageInputRejectedError',
      logContext: { reason: 'source_header' },
    });
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
