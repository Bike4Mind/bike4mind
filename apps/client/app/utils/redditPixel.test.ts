import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackRedditEvent, loadRedditPixel } from './redditPixel';

type RdtWindow = Window & {
  rdt?: ((...args: unknown[]) => void) & { callQueue?: unknown[] };
};

const win = window as RdtWindow;

describe('redditPixel', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_REDDIT_PIXEL_ID', 'a2_test123');
    delete win.rdt;
    document.getElementById('reddit-pixel')?.remove();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-ops entirely when the pixel is not configured', () => {
    vi.stubEnv('NEXT_PUBLIC_REDDIT_PIXEL_ID', '');
    trackRedditEvent('SignUp');
    loadRedditPixel();
    expect(win.rdt).toBeUndefined();
    expect(document.getElementById('reddit-pixel')).toBeNull();
  });

  it('queues init + events in memory without loading any script', () => {
    trackRedditEvent('SignUp');
    expect(win.rdt).toBeTypeOf('function');
    expect(win.rdt!.callQueue).toEqual([
      ['init', 'a2_test123'],
      ['track', 'SignUp'],
    ]);
    // Nothing on the network until consent loads the script.
    expect(document.getElementById('reddit-pixel')).toBeNull();
  });

  it('loadRedditPixel injects the script once and keeps the queue', () => {
    trackRedditEvent('SignUp');
    loadRedditPixel();
    loadRedditPixel();
    const scripts = document.querySelectorAll('#reddit-pixel');
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe('https://www.redditstatic.com/ads/pixel.js');
    // The queued events are still there for pixel.js to flush on load.
    expect(win.rdt!.callQueue).toEqual([
      ['init', 'a2_test123'],
      ['track', 'SignUp'],
    ]);
  });

  it('does not re-install the stub or re-init when rdt already exists', () => {
    const existing = vi.fn();
    win.rdt = existing;
    trackRedditEvent('SignUp');
    expect(win.rdt).toBe(existing);
    expect(existing).toHaveBeenCalledWith('track', 'SignUp');
    expect(existing).not.toHaveBeenCalledWith('init', 'a2_test123');
  });
});
