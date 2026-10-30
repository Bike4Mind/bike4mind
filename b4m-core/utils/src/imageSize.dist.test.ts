import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// The source tests import image-size through vitest's ESM interop, which hides how the bundler
// rewrites the import. Only the built entries show whether the CJS build can still call it.
const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const require = createRequire(import.meta.url);

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

describe('built image-size consumers', () => {
  it('reads the pixel count through the CJS entry', () => {
    const { imagePixelCount } = require(path.join(distDir, 'imageResize.cjs'));
    expect(imagePixelCount(pngHeader(8000, 8000))).toBe(64_000_000);
  });

  it('reads the pixel count through the ESM entry', async () => {
    const { imagePixelCount } = await import(pathToFileURL(path.join(distDir, 'imageResize.mjs')).href);
    expect(imagePixelCount(pngHeader(8000, 8000))).toBe(64_000_000);
  });

  it.each(['imageResize.cjs', 'imageModeration/index.cjs'])('%s calls the named imageSize export', file => {
    // image-size 2 has no callable default export; node-mode interop makes `.default` the whole module.
    const source = readFileSync(path.join(distDir, file), 'utf-8');
    expect(source).not.toMatch(/image_size\.default\b/);
    expect(source).toMatch(/image_size\.imageSize\b/);
  });
});
