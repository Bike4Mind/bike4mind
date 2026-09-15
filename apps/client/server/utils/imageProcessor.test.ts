import { describe, it, expect } from 'vitest';
import { handler } from './imageProcessor';

/** A valid PNG header declaring width x height (image-size reads the IHDR without decoding). */
function pngHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  head.write('89504e470d0a1a0a', 0, 'hex');
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(6, 25);
  return head;
}

describe('imageProcessor handler', () => {
  it('rejects an image that declares more pixels than the processing limit, before decoding', async () => {
    // A 33-byte header declaring 20000x20000 (4e8 px) - decoding would allocate ~1.6GB.
    const bomb = pngHeader(20000, 20000).toString('base64');
    const start = Date.now();
    await expect(handler({ imageBuffer: bomb })).rejects.toThrow(/pixel/);
    expect(Date.now() - start).toBeLessThan(500); // rejected before any decode
  });
});
