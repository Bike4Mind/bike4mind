import { describe, expect, it } from 'vitest';
import { detectPlatform, detectPlatformFromUserAgent } from './desktopPlatform';

const UA = {
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  linuxArm: 'Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

describe('detectPlatformFromUserAgent', () => {
  it('never claims to know a Mac chip from the user agent, which always says Intel', () => {
    expect(detectPlatformFromUserAgent(UA.macSafari)).toEqual({ os: 'mac', arch: 'unknown' });
    expect(detectPlatformFromUserAgent(UA.macChrome)).toEqual({ os: 'mac', arch: 'unknown' });
  });

  it('reads the Linux architecture from the user agent', () => {
    expect(detectPlatformFromUserAgent(UA.linuxFirefox)).toEqual({ os: 'linux', arch: 'x64' });
    expect(detectPlatformFromUserAgent(UA.linuxArm)).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('detects Windows', () => {
    expect(detectPlatformFromUserAgent(UA.windowsEdge).os).toBe('windows');
  });

  it.each([
    ['Android', UA.android],
    ['iPhone', UA.iphone],
    ['ChromeOS', UA.chromeOs],
  ])('treats %s as a platform with no desktop build', (_name, ua) => {
    expect(detectPlatformFromUserAgent(ua)).toEqual({ os: 'other', arch: 'unknown' });
  });

  it('treats an iPad asking for the desktop site (a Mac user agent with touch) as no desktop build', () => {
    expect(detectPlatformFromUserAgent(UA.macSafari, 5)).toEqual({ os: 'other', arch: 'unknown' });
  });
});

describe('detectPlatform', () => {
  const withHints = (platform: string, values: { architecture?: string; bitness?: string } | Error) => ({
    platform,
    getHighEntropyValues: () => (values instanceof Error ? Promise.reject(values) : Promise.resolve(values)),
  });

  it('falls back to the user agent without client hints', async () => {
    await expect(detectPlatform({ userAgent: UA.macSafari })).resolves.toEqual({ os: 'mac', arch: 'unknown' });
  });

  it('identifies an Apple Silicon Mac from the architecture hint', async () => {
    const nav = { userAgent: UA.macChrome, userAgentData: withHints('macOS', { architecture: 'arm', bitness: '64' }) };
    await expect(detectPlatform(nav)).resolves.toEqual({ os: 'mac', arch: 'arm64' });
  });

  it('identifies an Intel Mac from the architecture hint', async () => {
    const nav = { userAgent: UA.macChrome, userAgentData: withHints('macOS', { architecture: 'x86', bitness: '64' }) };
    await expect(detectPlatform(nav)).resolves.toEqual({ os: 'mac', arch: 'x64' });
  });

  it('keeps the chip unknown when the browser refuses high-entropy hints', async () => {
    const nav = { userAgent: UA.macChrome, userAgentData: withHints('macOS', new Error('NotAllowedError')) };
    await expect(detectPlatform(nav)).resolves.toEqual({ os: 'mac', arch: 'unknown' });
  });

  it('lets the platform hint override the user agent', async () => {
    const nav = { userAgent: UA.linuxFirefox, userAgentData: withHints('Android', { architecture: 'arm' }) };
    await expect(detectPlatform(nav)).resolves.toEqual({ os: 'other', arch: 'unknown' });
  });
});
