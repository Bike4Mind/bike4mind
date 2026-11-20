import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeWebp } from './webpDecode';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

describe('decodeWebp', () => {
  it('decodes a still WebP to RGBA', async () => {
    const { data, width, height } = await decodeWebp(fixture('still-red.webp'));

    expect({ width, height }).toEqual({ width: 32, height: 32 });
    expect(data).toHaveLength(32 * 32 * 4);
    const [r, g, b, a] = data;
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    expect(a).toBe(255);
  });

  it('decodes a Buffer that is a slice of a larger allocation', async () => {
    const webp = fixture('still-red.webp');
    const padded = Buffer.concat([Buffer.alloc(7), webp, Buffer.alloc(5)]);

    await expect(decodeWebp(padded.subarray(7, 7 + webp.length))).resolves.toMatchObject({ width: 32, height: 32 });
  });

  it('rejects bytes that are not a still WebP', async () => {
    await expect(decodeWebp(fixture('tiles.png'))).rejects.toThrow();
  });
});
