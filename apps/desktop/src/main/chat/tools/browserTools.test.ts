import { describe, expect, it, vi } from 'vitest';
import type { ChatMedia } from '@shared/chat';
import {
  browserClick,
  browserEvaluate,
  browserNavigate,
  browserScreenshot,
  browserSnapshot,
  browserType,
  isLocalUrl,
} from './browserTools';
import type { BrowserPage, ToolContext } from './types';

function fakePage(start = ''): BrowserPage & { url: string; events: string[] } {
  const page = {
    url: start,
    events: [] as string[],
    currentUrl: () => page.url,
    navigate: vi.fn(async (url: string) => {
      page.url = url;
      return { url, title: 'Home', status: 200 };
    }),
    back: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ url: page.url, title: 'Home', text: '[1] button "Add"', truncated: false })),
    click: vi.fn(async () => 'Add'),
    fill: vi.fn(async () => 'filled "x"'),
    press: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('png')),
    evaluate: vi.fn(async () => ({ level: 2 })),
    drainEvents: () => page.events.splice(0),
    settle: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return page;
}

function contextFor(page: BrowserPage) {
  const media: ChatMedia[] = [];
  const images: { bytes: Buffer; mimeType: string }[] = [];
  const context: ToolContext = {
    roots: ['/repo'],
    signal: new AbortController().signal,
    browser: {
      page: async () => page,
      keepScreenshot: async (bytes, caption) => ({
        kind: 'image',
        url: 'b4m-media://m/s/1.png',
        mimeType: 'image/png',
        byteLength: bytes.length,
        caption,
      }),
    },
    report: {
      progress: () => undefined,
      media: item => media.push(item),
      notice: () => undefined,
      label: () => undefined,
      diff: () => undefined,
      detail: () => undefined,
      image: (bytes, mimeType) => images.push({ bytes, mimeType }),
    },
  };
  return { context, media, images };
}

describe('isLocalUrl', () => {
  it('treats dev servers as local and real sites as not', () => {
    expect(isLocalUrl('http://localhost:3080/app')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:5173')).toBe(true);
    expect(isLocalUrl('http://[::1]:3000')).toBe(true);
    expect(isLocalUrl('http://budget.test')).toBe(true);
    expect(isLocalUrl('https://example.com')).toBe(false);
    expect(isLocalUrl('https://localhost.example.com')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });
});

describe('browser tools', () => {
  it('opens a local page unasked and returns its snapshot with what happened on the way', async () => {
    const page = fakePage();
    const { context } = contextFor(page);
    expect(await browserNavigate.needsApproval!({ url: 'localhost:3080' }, context)).toBe(false);
    page.events.push('GET http://localhost:3080/api/me -> HTTP 401');

    const result = await browserNavigate.run({ url: 'localhost:3080' }, context);
    expect(page.navigate).toHaveBeenCalledWith('http://localhost:3080/');
    expect(result).toContain('Loaded http://localhost:3080/ (HTTP 200).');
    expect(result).toContain('[1] button "Add"');
    expect(result).toContain('- GET http://localhost:3080/api/me -> HTTP 401');
  });

  it('asks per origin before opening a real site, and refuses other schemes outright', async () => {
    const { context } = contextFor(fakePage());
    expect(await browserNavigate.needsApproval!({ url: 'example.com/cart' }, context)).toBe(true);
    const prompt = await browserNavigate.approval!({ url: 'example.com/cart' }, context);
    expect(prompt).toMatchObject({ detail: 'Open https://example.com/cart', key: 'browser-open:https://example.com' });
    expect(() => browserNavigate.needsApproval!({ url: 'file:///etc/passwd' }, context)).toThrow(/http and https/);
  });

  it('acts freely on a local page but asks before acting on a real site', async () => {
    const local = contextFor(fakePage('http://localhost:3080/app'));
    expect(await browserClick.needsApproval!({ ref: '1' }, local.context)).toBe(false);

    const remote = contextFor(fakePage('https://shop.example.com/checkout'));
    expect(await browserClick.needsApproval!({ ref: '1' }, remote.context)).toBe(true);
    expect(await browserClick.approval!({ ref: '1' }, remote.context)).toMatchObject({
      detail: 'Click on https://shop.example.com (element 1)',
      key: 'browser-act:https://shop.example.com',
    });
  });

  it('returns the page after a click, accepting a bracketed ref', async () => {
    const page = fakePage('http://localhost:3080/app');
    const result = await browserClick.run({ ref: '[1]' }, contextFor(page).context);
    expect(page.click).toHaveBeenCalledWith('1');
    expect(page.settle).toHaveBeenCalled();
    expect(result).toMatch(/^Clicked \[1\] Add\.\nPage: Home - http:\/\/localhost:3080\/app\n\n\[1\] button "Add"$/);
  });

  it('fills and optionally submits', async () => {
    const page = fakePage('http://localhost:3080/login');
    const result = await browserType.run({ ref: '2', text: 'x', submit: true }, contextFor(page).context);
    expect(page.fill).toHaveBeenCalledWith('2', 'x');
    expect(page.press).toHaveBeenCalledWith('Enter');
    expect(result).toContain('[2] filled "x", then pressed Enter.');
  });

  it('shows a screenshot to both the user and the model', async () => {
    const page = fakePage('http://localhost:3080/app/achievements');
    const { context, media, images } = contextFor(page);
    const result = await browserScreenshot.run({ caption: 'Achievements after the first transaction' }, context);
    expect(result).toContain('Captured a screenshot of http://localhost:3080/app/achievements');
    expect(media).toEqual([
      expect.objectContaining({ kind: 'image', caption: 'Achievements after the first transaction' }),
    ]);
    expect(images).toEqual([{ bytes: Buffer.from('png'), mimeType: 'image/png' }]);
  });

  it('needs an open page for the reading tools', async () => {
    const { context } = contextFor(fakePage());
    await expect(browserSnapshot.run({}, context)).rejects.toThrow(/browser_navigate first/);
    await expect(browserScreenshot.run({}, context)).rejects.toThrow(/browser_navigate first/);
    await expect(browserEvaluate.run({ expression: '1' }, context)).rejects.toThrow(/browser_navigate first/);
  });

  it('returns an evaluated value as JSON', async () => {
    const page = fakePage('http://localhost:3080/app');
    expect(await browserEvaluate.run({ expression: 'x' }, contextFor(page).context)).toBe('{\n "level": 2\n}');
  });

  it('refuses when the session has no browser', async () => {
    await expect(
      browserNavigate.run({ url: 'localhost:3000' }, { roots: [], signal: new AbortController().signal })
    ).rejects.toThrow(/not available/);
  });
});
