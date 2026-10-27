import { describe, it, expect } from 'vitest';
import { collectInlineAssets, TOTAL_INLINE_MAX_BYTES } from './collectInlineAssets';

const m = (path: string, mimeType = 'image/png') => ({ path, mimeType });

describe('collectInlineAssets', () => {
  it('fetches in-budget assets and skips index.html', async () => {
    const manifest = [m('index.html', 'text/html'), m('a.png'), m('b.css', 'text/css')];
    const load = async (p: string) => Buffer.from(`bytes:${p}`);
    const { assets, oversized, failed } = await collectInlineAssets({ manifest, load });
    expect([...assets.keys()].sort()).toEqual(['a.png', 'b.css']);
    expect(assets.get('a.png')?.mimeType).toBe('image/png');
    expect(oversized).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  it('skips a single asset above the per-asset cap', async () => {
    const manifest = [m('big.png'), m('small.png')];
    const load = async (p: string) => Buffer.alloc(p === 'big.png' ? 100 : 10);
    const { assets, oversized } = await collectInlineAssets({
      manifest,
      load,
      perAssetMaxBytes: 50,
      totalMaxBytes: 1000,
    });
    expect(oversized).toEqual(['big.png']);
    expect(assets.has('small.png')).toBe(true);
    expect(assets.has('big.png')).toBe(false);
  });

  it('stops inlining once the cumulative cap is reached', async () => {
    const manifest = [m('a.png'), m('b.png'), m('c.png')];
    const load = async () => Buffer.alloc(40);
    const { assets, oversized } = await collectInlineAssets({
      manifest,
      load,
      perAssetMaxBytes: 100,
      totalMaxBytes: 160,
    });
    // Each 40-byte asset encodes to 78 bytes: a + b = 156 fits; c would exceed.
    expect(assets.size).toBe(2);
    expect(oversized).toEqual(['c.png']);
  });

  it('applies the cumulative cap in manifest order regardless of fetch-completion order', async () => {
    const manifest = [m('first.png'), m('second.png')];
    // 'first' resolves AFTER 'second' - but manifest order must still decide who is in-budget.
    const load = (p: string) =>
      new Promise<Buffer>(resolve => {
        const delay = p === 'first.png' ? 20 : 0;
        setTimeout(() => resolve(Buffer.alloc(40)), delay);
      });
    const { assets, oversized } = await collectInlineAssets({
      manifest,
      load,
      perAssetMaxBytes: 100,
      totalMaxBytes: 100, // only one 78-byte encoded asset fits
    });
    expect([...assets.keys()]).toEqual(['first.png']);
    expect(oversized).toEqual(['second.png']);
  });

  it('records a download failure without aborting the rest', async () => {
    const manifest = [m('ok.png'), m('broken.png')];
    const load = async (p: string) => {
      if (p === 'broken.png') throw new Error('boom');
      return Buffer.from('ok');
    };
    const { assets, failed } = await collectInlineAssets({ manifest, load });
    expect(failed).toEqual(['broken.png']);
    expect(assets.has('ok.png')).toBe(true);
  });

  // 30 raw bytes -> 40 base64 + the 22-byte `data:image/png;base64,` prefix = 62 encoded.
  const thirtyBytes = async () => Buffer.alloc(30);
  const three = [m('a.png'), m('b.png'), m('c.png')];

  it('counts base64-encoded size, not raw size, against the budget', async () => {
    const { assets, oversized } = await collectInlineAssets({
      manifest: three,
      load: thirtyBytes,
      totalMaxBytes: 110, // raw total 90 fits, encoded 186 does not
    });
    expect([...assets.keys()]).toEqual(['a.png']);
    expect(oversized).toEqual(['b.png', 'c.png']);
  });

  it('subtracts reservedBytes from the budget', async () => {
    const { assets, oversized } = await collectInlineAssets({
      manifest: three,
      load: thirtyBytes,
      totalMaxBytes: 130, // two encoded assets (124) fit...
      reservedBytes: 10, // ...until index.html claims room
    });
    expect(assets.size).toBe(1);
    expect(oversized).toEqual(['b.png', 'c.png']);
  });

  it('budgets assets without a fallback before ones that have one, whatever the manifest order', async () => {
    const manifest = [m('a.png'), m('b.png'), m('style.css', 'text/css')];
    const { assets, oversized } = await collectInlineAssets({
      manifest,
      load: async () => Buffer.alloc(40),
      perAssetMaxBytes: 100,
      totalMaxBytes: 160, // two 78-byte encoded assets fit
      hasFallback: p => p.endsWith('.png'),
    });
    expect([...assets.keys()]).toEqual(['style.css', 'a.png']);
    expect(oversized).toEqual(['b.png']);
  });

  it('reports oversized paths in manifest order when the budget order differs', async () => {
    const manifest = [m('a.png'), m('b.png'), m('big.css', 'text/css')];
    const { oversized } = await collectInlineAssets({
      manifest,
      load: async p => Buffer.alloc(p === 'big.css' ? 200 : 40),
      perAssetMaxBytes: 100,
      totalMaxBytes: 80,
      hasFallback: p => p.endsWith('.png'),
    });
    expect(oversized).toEqual(['b.png', 'big.css']);
  });

  it('keeps the default budget under Lambda 6 MB for ~5 MB of raw images', async () => {
    const manifest = Array.from({ length: 14 }, (_, i) => m(`img${i}.png`));
    const { assets, oversized } = await collectInlineAssets({
      manifest,
      load: async () => Buffer.alloc(360 * 1024),
    });
    const encoded = [...assets.values()].reduce((n, a) => n + a.data.toString('base64').length, 0);
    expect(encoded).toBeLessThanOrEqual(TOTAL_INLINE_MAX_BYTES);
    expect(assets.size + oversized.length).toBe(14);
    expect(oversized.length).toBeGreaterThan(0);
  });
});
