import { describe, it, expect } from 'vitest';
import { collectInlineAssets } from './collectInlineAssets';

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
      totalMaxBytes: 80,
    });
    // a (40) + b (40) = 80 fits; c would exceed.
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
      totalMaxBytes: 60, // only one 40-byte asset fits
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
});
