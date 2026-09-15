import { describe, it, expect } from 'vitest';
import { imagePixelCount, MAX_IMAGE_PIXELS, ensureImageWithinDimensionLimit } from './imageResize';

/**
 * A valid PNG header declaring `width` x `height`, optionally padded. image-size reads the
 * dimensions from the IHDR without decoding, so this stands in for a decompression bomb: a
 * tiny/uniform file that declares a huge canvas.
 */
function pngHeader(width: number, height: number, padTo = 0): Buffer {
  const head = Buffer.alloc(33);
  head.write('89504e470d0a1a0a', 0, 'hex'); // PNG signature
  head.writeUInt32BE(13, 8); // IHDR length
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24); // bit depth
  head.writeUInt8(6, 25); // color type: RGBA
  return padTo > head.length ? Buffer.concat([head, Buffer.alloc(padTo - head.length)]) : head;
}

// A real, valid 2x2 red PNG jimp both sniffs and fully decodes (well under any pixel budget).
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4AWP8z8DwnwEImBigAAAfFwICgH3ifwAAAABJRU5ErkJggg==',
  'base64'
);

describe('imagePixelCount', () => {
  it('reads the pixel count from a PNG header without decoding', () => {
    expect(imagePixelCount(pngHeader(1234, 1000))).toBe(1234 * 1000);
  });

  it('returns null for bytes with no readable image header', () => {
    expect(imagePixelCount(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('ensureImageWithinDimensionLimit', () => {
  it('passes an over-budget image through undecoded rather than allocating its bitmap', async () => {
    const bomb = pngHeader(20000, 20000); // 4e8 px, ~1.6GB if decoded
    expect(imagePixelCount(bomb)).toBeGreaterThan(MAX_IMAGE_PIXELS);
    const start = Date.now();
    const out = await ensureImageWithinDimensionLimit(bomb);
    expect(out).toBe(bomb); // returned as-is: never decoded
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('still processes a normal small image (the guard does not block legit images)', async () => {
    const out = await ensureImageWithinDimensionLimit(REAL_PNG);
    expect(Buffer.isBuffer(out)).toBe(true);
  });
});
