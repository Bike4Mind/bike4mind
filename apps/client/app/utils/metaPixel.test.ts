import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackMetaEvent, loadMetaPixel } from './metaPixel';

type FbqWindow = Window & {
  fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; callMethod?: (...args: unknown[]) => void };
  _fbq?: unknown;
};

const win = window as FbqWindow;

describe('metaPixel', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '1234567890');
    delete win.fbq;
    delete win._fbq;
    document.getElementById('meta-pixel')?.remove();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-ops entirely when the pixel is not configured', () => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '');
    trackMetaEvent('CompleteRegistration');
    loadMetaPixel();
    expect(win.fbq).toBeUndefined();
    expect(document.getElementById('meta-pixel')).toBeNull();
  });

  it('queues init + events in memory without loading any script', () => {
    trackMetaEvent('CompleteRegistration');
    expect(win.fbq).toBeTypeOf('function');
    expect(win.fbq!.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'CompleteRegistration'],
    ]);
    // Nothing on the network until consent loads the script.
    expect(document.getElementById('meta-pixel')).toBeNull();
  });

  it('installs the stub shape fbevents.js expects to adopt', () => {
    trackMetaEvent('CompleteRegistration');
    const fbq = win.fbq!;
    expect(win._fbq).toBe(fbq);
    expect((fbq as unknown as { push: unknown }).push).toBe(fbq);
    expect((fbq as unknown as { loaded: boolean }).loaded).toBe(true);
    expect((fbq as unknown as { version: string }).version).toBe('2.0');
  });

  it('routes through callMethod once fbevents.js has loaded', () => {
    trackMetaEvent('CompleteRegistration');
    const fbq = win.fbq!;
    const callMethod = vi.fn();
    fbq.callMethod = callMethod;

    trackMetaEvent('Subscribe', { value: 30, currency: 'USD' });

    expect(callMethod).toHaveBeenCalledWith('track', 'Subscribe', { value: 30, currency: 'USD' });
    // The pre-load queue is left alone for fbevents.js to drain itself.
    expect(fbq.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'CompleteRegistration'],
    ]);
  });

  it('loadMetaPixel injects the script once and keeps the queue', () => {
    trackMetaEvent('CompleteRegistration');
    loadMetaPixel();
    loadMetaPixel();
    const scripts = document.querySelectorAll('#meta-pixel');
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe('https://connect.facebook.net/en_US/fbevents.js');
    expect(win.fbq!.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'CompleteRegistration'],
    ]);
  });

  it('does not re-install the stub or re-init when fbq already exists', () => {
    const existing = vi.fn();
    win.fbq = existing;
    trackMetaEvent('CompleteRegistration');
    expect(win.fbq).toBe(existing);
    expect(existing).toHaveBeenCalledWith('track', 'CompleteRegistration');
    expect(existing).not.toHaveBeenCalledWith('init', '1234567890');
  });

  it('passes value and currency through, with the dedupe id in the options argument', () => {
    trackMetaEvent('Subscribe', { value: 30, currency: 'USD', eventId: 'cs_1' });
    expect(win.fbq!.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'Subscribe', { value: 30, currency: 'USD' }, { eventID: 'cs_1' }],
    ]);
  });

  it('keeps an empty params object in front of a bare dedupe id', () => {
    trackMetaEvent('CompleteRegistration', { eventId: 'cs_2' });
    expect(win.fbq!.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'CompleteRegistration', {}, { eventID: 'cs_2' }],
    ]);
  });

  it('keeps the two-argument shape when no metadata is supplied', () => {
    trackMetaEvent('CompleteRegistration', {});
    expect(win.fbq!.queue).toEqual([
      ['init', '1234567890'],
      ['track', 'CompleteRegistration'],
    ]);
  });
});
