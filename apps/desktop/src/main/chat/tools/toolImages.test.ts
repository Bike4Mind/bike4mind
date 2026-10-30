import { describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_INPUT_BYTES, showImage, sniffImageType } from './toolImages';
import type { ImageContext, ToolContext } from './types';

const bytesOf = (...values: number[]) => Buffer.from(values);
const ascii = (text: string) => Buffer.from(text, 'latin1');

describe('sniffImageType', () => {
  it('recognises each supported signature', () => {
    expect(sniffImageType(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffImageType(bytesOf(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(ascii('GIF87a....'))).toBe('image/gif');
    expect(sniffImageType(ascii('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(Buffer.concat([ascii('RIFF'), bytesOf(0, 0, 0, 0), ascii('WEBPVP8 ')]))).toBe('image/webp');
  });

  it('rejects other RIFF containers, text and truncated input', () => {
    expect(sniffImageType(Buffer.concat([ascii('RIFF'), bytesOf(0, 0, 0, 0), ascii('WAVEfmt ')]))).toBeNull();
    expect(sniffImageType(ascii('GIF88a'))).toBeNull();
    expect(sniffImageType(ascii('hello world, not an image'))).toBeNull();
    expect(sniffImageType(bytesOf(0xff, 0xd8))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('showImage', () => {
  const contextWith = (prepare: ImageContext['prepare']) => {
    const image = vi.fn();
    const context = { images: { vision: true, prepare }, report: { image } } as unknown as ToolContext;
    return { context, image };
  };

  it('refuses input too large to decode, without attaching anything', () => {
    const { context, image } = contextWith(() => null);
    const shown = showImage(context, Buffer.alloc(MAX_TOOL_IMAGE_INPUT_BYTES + 1), 'image/png');
    expect(shown).toMatchObject({ ok: false });
    expect(shown.ok === false && shown.reason).toContain('larger than');
    expect(image).not.toHaveBeenCalled();
  });

  it('refuses an oversize GIF the decoder cannot read', () => {
    const { context, image } = contextWith(() => null);
    const shown = showImage(context, Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 1), 'image/gif');
    expect(shown.ok === false && shown.reason).toContain('cannot be downscaled');
    expect(image).not.toHaveBeenCalled();
  });

  it('refuses a PNG the decoder could not fit', () => {
    const { context } = contextWith(() => null);
    const shown = showImage(context, Buffer.alloc(10), 'image/png');
    expect(shown.ok === false && shown.reason).toContain('could not be decoded');
  });

  it('reports the downscale when the shown size differs from the source', () => {
    const fitted = Buffer.from('fitted');
    const { context, image } = contextWith(() => ({
      bytes: fitted,
      mediaType: 'image/jpeg',
      width: 1568,
      height: 1045,
      sourceWidth: 3000,
      sourceHeight: 2000,
    }));
    expect(showImage(context, Buffer.alloc(10), 'image/png')).toEqual({
      ok: true,
      pixels: '3000x2000, shown to you at 1568x1045',
    });
    expect(image).toHaveBeenCalledWith(fitted, 'image/jpeg');
  });
});
