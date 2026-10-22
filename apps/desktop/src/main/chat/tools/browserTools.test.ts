import { describe, expect, it, vi } from 'vitest';
import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import type { ChatMedia } from '@shared/chat';
import {
  browserBack,
  browserClick,
  browserEvaluate,
  browserNavigate,
  browserScreenshot,
  browserScroll,
  browserSnapshot,
  browserTabs,
  browserType,
  isLocalUrl,
} from './browserTools';
import type { BrowserPage, BrowserTabInfo, ToolContext } from './types';

function fakePage(start = ''): BrowserPage & { url: string; events: string[] } {
  const page = {
    url: start,
    events: [] as string[],
    currentUrl: () => page.url,
    frameUrls: vi.fn(() => (page.url ? [page.url] : [])),
    navigate: vi.fn(async (url: string) => {
      page.url = url;
      return { url, title: 'Home', status: 200 };
    }),
    back: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ url: page.url, title: 'Home', text: '[1] button "Add"', truncated: false })),
    click: vi.fn(async () => 'Add'),
    scroll: vi.fn(async () => 'Pricing plans'),
    fill: vi.fn(async () => 'filled "x"'),
    press: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('png')),
    evaluate: vi.fn(async () => ({ level: 2 })),
    drainEvents: () => page.events.splice(0),
    settle: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return page;
}

/** A tab strip shaped like BrowserManager's: ids in opening order, the neighbour active after a close. */
function fakeTabs(first: BrowserPage) {
  const open = [{ id: 1, page: first }];
  let active = 1;
  let nextId = 2;
  const info = (entry: (typeof open)[number]): BrowserTabInfo => ({
    id: entry.id,
    title: entry.page.currentUrl() ? 'Home' : '',
    url: entry.page.currentUrl(),
    active: entry.id === active,
  });
  const named = (id: number) => {
    const entry = open.find(candidate => candidate.id === id);
    if (!entry) throw new Error(`There is no tab ${id}.`);
    return entry;
  };
  return {
    open,
    page: async () => named(active).page,
    tabs: () => open.map(info),
    newTab: async () => {
      if (open.length >= MAX_BROWSER_TABS) return null;
      const entry = { id: nextId++, page: fakePage() };
      open.push(entry);
      active = entry.id;
      return entry.page;
    },
    selectTab: async (id: number) => {
      active = named(id).id;
      return info(named(id));
    },
    closeTab: async (id: number) => {
      const entry = named(id);
      const closed = info(entry);
      const index = open.indexOf(entry);
      open.splice(index, 1);
      if (active === id) active = (open[index] ?? open[index - 1])?.id ?? 0;
      return closed;
    },
  };
}

function contextFor(page: BrowserPage, importedSites: readonly string[] = []) {
  const media: ChatMedia[] = [];
  const images: { bytes: Buffer; mimeType: string }[] = [];
  const labels: string[] = [];
  const tabs = fakeTabs(page);
  const context: ToolContext = {
    roots: ['/repo'],
    signal: new AbortController().signal,
    browser: {
      page: tabs.page,
      tabs: tabs.tabs,
      newTab: tabs.newTab,
      selectTab: tabs.selectTab,
      closeTab: tabs.closeTab,
      usesImportedCookies: url => importedSites.some(site => new URL(url).hostname === site),
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
      label: text => labels.push(text),
      moved: () => undefined,
      ownContent: () => undefined,
      diff: () => undefined,
      detail: () => undefined,
      image: (bytes, mimeType) => images.push({ bytes, mimeType }),
    },
  };
  return { context, media, images, labels, open: tabs.open };
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

  /**
   * The url bar means the user can sign in to anything in this cookie jar, so a script on a real
   * site is asked about in EVERY mode, and under a key of its own: "always allow clicking here"
   * must never also mean "and run whatever JavaScript you like here".
   */
  it('gates a script harder than a click, and in every mode', async () => {
    const local = contextFor(fakePage('http://localhost:3080/app'));
    expect(await browserEvaluate.needsApproval!({ expression: '1' }, local.context)).toBe(false);

    const remote = contextFor(fakePage('https://app.example.com/inbox'));
    expect(await browserEvaluate.needsApproval!({ expression: '1' }, remote.context)).toBe(true);
    expect(await browserEvaluate.approval!({ expression: '1' }, remote.context)).toMatchObject({
      key: 'browser-script:https://app.example.com',
      askInAuto: true,
      askInFull: true,
    });
  });

  /**
   * A site the USER imported their own Chrome cookies for. Reaching it is reaching it as them,
   * which is not the decision 'auto' or 'full' was a judgement about - so every tool that
   * touches it asks, in every mode, under a key of its own. See cookies/CookieImporter.
   */
  describe('a site carrying the user imported cookies', () => {
    it('asks before opening it, in every mode', async () => {
      const { context } = contextFor(fakePage(), ['shop.example.com']);
      expect(await browserNavigate.needsApproval!({ url: 'shop.example.com/cart' }, context)).toBe(true);
      expect(await browserNavigate.approval!({ url: 'shop.example.com/cart' }, context)).toMatchObject({
        detail: 'Open https://shop.example.com/cart as your signed-in shop.example.com session',
        key: 'browser-open-as-you:https://shop.example.com',
        askInAuto: true,
        askInFull: true,
      });
    });

    it('asks before acting on it, apart from the same action taken anonymously', async () => {
      const { context } = contextFor(fakePage('https://shop.example.com/checkout'), ['shop.example.com']);
      expect(await browserClick.needsApproval!({ ref: '1' }, context)).toBe(true);
      expect(await browserClick.approval!({ ref: '1' }, context)).toMatchObject({
        detail: 'Click on https://shop.example.com (element 1), signed in as you',
        key: 'browser-act-as-you:https://shop.example.com',
        askInAuto: true,
        askInFull: true,
      });
    });

    it('asks even on a local dev server, where an action is otherwise free', async () => {
      const { context } = contextFor(fakePage('http://localhost:3080/app'), ['localhost']);
      expect(await browserClick.needsApproval!({ ref: '1' }, context)).toBe(true);
      expect(await browserNavigate.needsApproval!({ url: 'localhost:3080' }, context)).toBe(true);
    });

    it('leaves every other site exactly as it was', async () => {
      const { context } = contextFor(fakePage('http://localhost:3080/app'), ['shop.example.com']);
      expect(await browserClick.needsApproval!({ ref: '1' }, context)).toBe(false);
      expect(await browserNavigate.approval!({ url: 'example.com/cart' }, context)).toMatchObject({
        key: 'browser-open:https://example.com',
      });
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

  describe('browser_scroll', () => {
    it('brings a ref into view and shows only what is in view now', async () => {
      const page = fakePage('http://localhost:3080/app');
      const result = await browserScroll.run({ ref: '[12]' }, contextFor(page).context);
      expect(page.scroll).toHaveBeenCalledWith({ ref: '12' });
      expect(page.snapshot).toHaveBeenCalledWith(expect.any(Number), true);
      expect(result).toMatch(/^Scrolled \[12\] Pricing plans into view\. What is in view now:\nPage: Home/);
    });

    it('finds an element by its text', async () => {
      const page = fakePage('http://localhost:3080/app');
      const labels: string[] = [];
      const { context } = contextFor(page);
      const result = await browserScroll.run(
        { text: 'Pricing' },
        { ...context, report: { ...context.report!, label: text => labels.push(text) } }
      );
      expect(page.scroll).toHaveBeenCalledWith({ text: 'Pricing' });
      expect(result).toContain('Scrolled to the first element containing "Pricing": Pricing plans.');
      expect(labels).toEqual(['Scrolled to Pricing']);
    });

    it('scrolls by direction, a page by default or the amount asked for', async () => {
      const page = fakePage('http://localhost:3080/app');
      vi.mocked(page.scroll).mockResolvedValue('Scrolled down 720px in the page (now 720px of 4000px).');
      const { context } = contextFor(page);

      const result = await browserScroll.run({ direction: 'down' }, context);
      expect(page.scroll).toHaveBeenLastCalledWith({ direction: 'down' });
      expect(result).toMatch(/^Scrolled down 720px in the page \(now 720px of 4000px\)\. What is in view now:/);

      await browserScroll.run({ direction: 'Up', amount: 300, unit: 'pixels' }, context);
      expect(page.scroll).toHaveBeenLastCalledWith({ direction: 'up', pixels: 300 });
      await browserScroll.run({ direction: 'down', amount: 2.5 }, context);
      expect(page.scroll).toHaveBeenLastCalledWith({ direction: 'down', pages: 2.5 });
    });

    it('passes on a target that matched nothing as a plain error, without a snapshot', async () => {
      const page = fakePage('http://localhost:3080/app');
      vi.mocked(page.scroll).mockRejectedValue(
        new Error('No element matched ref 99; take a browser_snapshot for current refs.')
      );
      await expect(browserScroll.run({ ref: '99' }, contextFor(page).context)).rejects.toThrow(
        /^No element matched ref 99; take a browser_snapshot for current refs\.$/
      );
      expect(page.snapshot).not.toHaveBeenCalled();
    });

    it('wants exactly one target and a sane amount', async () => {
      const { context } = contextFor(fakePage('http://localhost:3080/app'));
      await expect(browserScroll.run({}, context)).rejects.toThrow(/exactly one of/);
      await expect(browserScroll.run({ ref: '1', direction: 'down' }, context)).rejects.toThrow(/exactly one of/);
      await expect(browserScroll.run({ direction: 'sideways' }, context)).rejects.toThrow(/must be one of/);
      await expect(browserScroll.run({ direction: 'down', amount: -1 }, context)).rejects.toThrow(/positive/);
      await expect(browserScroll.run({ ref: '12"]' }, context)).rejects.toThrow(
        /^No element matched ref 12"; take a browser_snapshot/
      );
    });

    it('takes a numeric ref and never turns a small pixel amount into a full page', async () => {
      const page = fakePage('http://localhost:3080/app');
      const { context } = contextFor(page);
      await browserScroll.run({ ref: 12 }, context);
      expect(page.scroll).toHaveBeenLastCalledWith({ ref: '12' });
      await browserScroll.run({ direction: 'down', amount: 0.4, unit: 'pixels' }, context);
      expect(page.scroll).toHaveBeenLastCalledWith({ direction: 'down', pixels: 1 });
    });

    it('is gated like a click', async () => {
      const remote = contextFor(fakePage('https://shop.example.com/'));
      expect(await browserScroll.needsApproval!({ direction: 'down' }, remote.context)).toBe(true);
      const local = contextFor(fakePage('http://localhost:3080/app'));
      expect(await browserScroll.needsApproval!({ direction: 'down' }, local.context)).toBe(false);
    });
  });

  it('adds a hint to a script that read a property of nothing, keeping the page message', async () => {
    const page = fakePage('http://localhost:3080/app');
    vi.mocked(page.evaluate).mockRejectedValue(
      new TypeError("Cannot read properties of null (reading 'scrollIntoView')")
    );
    const run = browserEvaluate.run(
      { expression: "document.querySelector('#x').scrollIntoView()" },
      contextFor(page).context
    );
    await expect(run).rejects.toThrow(
      /^Cannot read properties of null \(reading 'scrollIntoView'\)\nHint: a selector probably matched nothing\..*optional chaining.*browser_scroll/s
    );
  });

  it('passes other script errors on unchanged', async () => {
    const page = fakePage('http://localhost:3080/app');
    const failure = new ReferenceError('foo is not defined');
    vi.mocked(page.evaluate).mockRejectedValue(failure);
    await expect(browserEvaluate.run({ expression: 'foo' }, contextFor(page).context)).rejects.toBe(failure);
  });

  it('refuses when the session has no browser', async () => {
    await expect(
      browserNavigate.run({ url: 'localhost:3000' }, { roots: [], signal: new AbortController().signal })
    ).rejects.toThrow(/not available/);
  });
});

describe('browser tools at a stop or a deadline', () => {
  it('says when a page was cut off still loading, and still returns what arrived', async () => {
    const page = fakePage();
    vi.mocked(page.navigate).mockResolvedValueOnce({
      url: 'http://localhost:3080/',
      title: 'Home',
      status: 200,
      stillLoading: true,
    });
    const { context } = contextFor(page);

    const result = await browserNavigate.run({ url: 'localhost:3080' }, context);
    expect(result).toContain('Loaded http://localhost:3080/ (HTTP 200), but it was still loading at the time limit');
    expect(result).toContain('[1] button "Add"');
  });

  it('stops the page loading and ends the step when the turn is stopped', async () => {
    const page = fakePage('http://localhost:3080/');
    vi.mocked(page.navigate).mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const { context } = contextFor(page);

    const running = browserNavigate.run({ url: 'localhost:3080/slow' }, { ...context, signal: controller.signal });
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalled());
    controller.abort();

    await expect(running).rejects.toThrow(/^Stopped: the turn was interrupted/);
    expect(page.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses to start a step once the turn is already stopped', async () => {
    const page = fakePage('http://localhost:3080/');
    const controller = new AbortController();
    controller.abort();
    const { context } = contextFor(page);

    await expect(browserSnapshot.run({}, { ...context, signal: controller.signal })).rejects.toThrow(/^Stopped/);
    expect(page.snapshot).not.toHaveBeenCalled();
  });
});

describe('browser tabs', () => {
  const pageOf = (open: { id: number; page: BrowserPage }[], id: number) =>
    open.find(entry => entry.id === id)?.page as ReturnType<typeof fakePage>;

  it('lists every tab with its id, title, url and which one is active', async () => {
    const { context } = contextFor(fakePage('http://localhost:3080/'));
    await browserTabs.run({ action: 'new' }, context);

    const listed = await browserTabs.run({ action: 'list' }, context);
    expect(listed).toContain(`2 of at most ${MAX_BROWSER_TABS} tabs open:`);
    expect(listed).toContain('- tab 1: Home - http://localhost:3080/');
    expect(listed).toContain('- tab 2 (active): (untitled) - (no page yet)');
  });

  it('opens a url in a new tab, leaving the old page where it was', async () => {
    const first = fakePage('http://localhost:3080/a');
    const { context, open, labels } = contextFor(first);

    const result = await browserTabs.run({ action: 'new', url: 'localhost:3080/b' }, context);

    expect(first.navigate).not.toHaveBeenCalled();
    expect(pageOf(open, 2).navigate).toHaveBeenCalledWith('http://localhost:3080/b');
    expect(result).toContain('Loaded http://localhost:3080/b (HTTP 200).');
    expect(labels.at(-1)).toBe('Opened tab: localhost:3080');
  });

  it('points every other tool at the active tab after a switch', async () => {
    const first = fakePage('http://localhost:3080/a');
    const { context, open, labels } = contextFor(first);
    await browserTabs.run({ action: 'new', url: 'localhost:3080/b' }, context);

    await browserClick.run({ ref: '1' }, context);
    expect(pageOf(open, 2).click).toHaveBeenCalledTimes(1);
    expect(first.click).not.toHaveBeenCalled();

    const switched = await browserTabs.run({ action: 'select', id: '1' }, context);
    expect(switched).toContain('Switched to tab 1.');
    expect(labels.at(-1)).toBe('Switched to tab: Home');
    await browserClick.run({ ref: '1' }, context);
    expect(first.click).toHaveBeenCalledTimes(1);
  });

  it('closes a tab and hands the active slot to its neighbour', async () => {
    const { context, open, labels } = contextFor(fakePage('http://localhost:3080/a'));
    await browserTabs.run({ action: 'new', url: 'localhost:3080/b' }, context);

    const result = await browserTabs.run({ action: 'close', id: 2 }, context);
    expect(result).toContain('Closed tab 2.');
    expect(result).toContain('- tab 1 (active)');
    expect(labels.at(-1)).toBe('Closed tab: Home');
    expect(open.map(entry => entry.id)).toEqual([1]);
  });

  it('refuses a tab id it cannot read, and an action it does not know', async () => {
    const { context } = contextFor(fakePage());
    await expect(browserTabs.run({ action: 'select' }, context)).rejects.toThrow(/"id" is required/);
    await expect(browserTabs.run({ action: 'close', id: 'two' }, context)).rejects.toThrow(/"id" is required/);
    await expect(browserTabs.run({ action: 'select', id: 9 }, context)).rejects.toThrow('There is no tab 9.');
    await expect(browserTabs.run({ action: 'move' }, context)).rejects.toThrow(/must be one of list, new/);
  });

  it('says so at the cap rather than opening another', async () => {
    const { context } = contextFor(fakePage());
    for (let i = 1; i < MAX_BROWSER_TABS; i++) await browserTabs.run({ action: 'new' }, context);

    await expect(browserTabs.run({ action: 'new' }, context)).rejects.toThrow(/already has 10 tabs open/);
  });

  it('opens a tab to a url under browser_navigate approval rules, and asks nothing for the rest', async () => {
    const { context } = contextFor(fakePage('https://example.com/'));
    expect(await browserTabs.needsApproval!({ action: 'new', url: 'localhost:3080' }, context)).toBe(false);
    expect(await browserTabs.needsApproval!({ action: 'new', url: 'example.com/cart' }, context)).toBe(true);
    expect(await browserTabs.approval!({ action: 'new', url: 'example.com/cart' }, context)).toMatchObject({
      detail: 'Open https://example.com/cart',
      key: 'browser-open:https://example.com',
    });
    for (const input of [
      { action: 'new' },
      { action: 'list' },
      { action: 'select', id: 1 },
      { action: 'close', id: 1 },
    ]) {
      expect(await browserTabs.needsApproval!(input, context)).toBe(false);
    }
  });

  it('opens browser_navigate in a new tab when asked, and in the active one past the cap', async () => {
    const first = fakePage('http://localhost:3080/a');
    const { context, open, labels } = contextFor(first);

    await browserNavigate.run({ url: 'localhost:3080/b', new_tab: true }, context);
    expect(first.navigate).not.toHaveBeenCalled();
    expect(pageOf(open, 2).navigate).toHaveBeenCalledWith('http://localhost:3080/b');
    expect(labels.at(-1)).toBe('Opened tab: localhost:3080');

    while (open.length < MAX_BROWSER_TABS) await browserTabs.run({ action: 'new' }, context);
    const active = pageOf(open, open.at(-1)!.id);
    const result = await browserNavigate.run({ url: 'localhost:3080/c', new_tab: true }, context);
    expect(active.navigate).toHaveBeenCalledWith('http://localhost:3080/c');
    expect(open).toHaveLength(MAX_BROWSER_TABS);
    expect(result).toMatch(/^This conversation already has 10 tabs open.*opened in the active tab instead/);
  });
});

/**
 * Consent to reach a signed-in site is checked on where the page IS when it is read, so a page the
 * agent got to without naming it - a script, a redirect, a link, history, a tab - is not read unasked.
 */
describe('reading a page that carries the user imported cookies', () => {
  const MAIL = 'https://mail.example.com';
  const INBOX = `${MAIL}/inbox?token=abc`;

  /** A page whose snapshot reads whatever it is on, with the inbox's text once it is there. */
  function pageThatReads(start: string) {
    const page = fakePage(start);
    vi.mocked(page.snapshot).mockImplementation(async () => ({
      url: page.url,
      title: page.url.startsWith(MAIL) ? 'Inbox (3) - jude' : 'Home',
      text: page.url.startsWith(MAIL) ? 'From: bank - your code is 123456' : '[1] button "Add"',
      truncated: false,
    }));
    return page;
  }

  function signedIn(page: BrowserPage, extra: Partial<ToolContext> = {}) {
    const built = contextFor(page, ['mail.example.com']);
    return { ...built, context: { ...built.context, ...extra } };
  }

  it('withholds the inbox a localhost script navigated to, and asks before the next snapshot reads it', async () => {
    const page = pageThatReads('http://localhost:3000/');
    const { context } = signedIn(page);
    vi.mocked(page.evaluate).mockImplementation(async () => {
      page.url = INBOX;
      page.events.push(`GET ${MAIL}/api/threads -> HTTP 200`);
      return undefined;
    });

    expect(await browserEvaluate.needsApproval!({ expression: 'location.href=1' }, context)).toBe(false);
    const evaluated = await browserEvaluate.run({ expression: 'location.href=1' }, context);
    expect(evaluated).toContain(`The page is now on ${MAIL}`);
    expect(evaluated).not.toContain('/api/threads');

    expect(await browserSnapshot.needsApproval!({}, context)).toBe(true);
    expect(await browserSnapshot.approval!({}, context)).toMatchObject({
      key: `browser-open-as-you:${MAIL}`,
      askInAuto: true,
      askInFull: true,
    });
    const unasked = await browserSnapshot.run({}, context);
    expect(unasked).not.toContain('123456');
    expect(unasked).not.toContain('Inbox (3)');
  });

  it('returns the inbox once the user allowed reading it, for this call or standing', async () => {
    const page = pageThatReads(INBOX);
    const once = signedIn(page, { approvedKey: `browser-open-as-you:${MAIL}` }).context;
    expect(await browserSnapshot.run({}, once)).toContain('123456');

    const standing = signedIn(page, { isStanding: key => key === `browser-open-as-you:${MAIL}` }).context;
    expect(await browserSnapshot.run({}, standing)).toContain('123456');
  });

  it('withholds a page a localhost url redirected to, naming only its origin', async () => {
    const page = pageThatReads('');
    vi.mocked(page.navigate).mockImplementation(async () => {
      page.url = INBOX;
      return { url: INBOX, title: 'Inbox', status: 200 };
    });
    const { context } = signedIn(page);

    expect(await browserNavigate.needsApproval!({ url: 'localhost:3000/go' }, context)).toBe(false);
    const result = await browserNavigate.run({ url: 'localhost:3000/go' }, context);
    expect(result).toContain(`Loaded ${MAIL} (HTTP 200).`);
    expect(result).not.toContain('token=abc');
    expect(result).not.toContain('123456');

    // An approval for the url that was typed is not one for wherever it ends up.
    const elsewhere = signedIn(page, { approvedKey: 'browser-open:https://shop.example.com' }).context;
    expect(await browserNavigate.run({ url: 'shop.example.com' }, elsewhere)).not.toContain('123456');
  });

  it('withholds a page reached by a link click on localhost, and by going back', async () => {
    const page = pageThatReads('http://localhost:3000/');
    const { context } = signedIn(page);
    vi.mocked(page.click).mockImplementation(async () => {
      page.url = INBOX;
      return 'link "Mail"';
    });
    expect(await browserClick.needsApproval!({ ref: '1' }, context)).toBe(false);
    expect(await browserClick.run({ ref: '1' }, context)).not.toContain('123456');

    page.url = 'http://localhost:3000/';
    vi.mocked(page.back).mockImplementation(async () => {
      page.url = INBOX;
    });
    const back = await browserBack.run({}, context);
    expect(back).toContain('Went back.');
    expect(back).not.toContain('123456');
  });

  it('asks before switching to a signed-in tab, and keeps its title out of the tab list', async () => {
    const { context } = signedIn(pageThatReads('http://localhost:3000/'));
    const mail = (await context.browser!.newTab()) as ReturnType<typeof fakePage>;
    mail.url = INBOX;

    expect(await browserTabs.needsApproval!({ action: 'select', id: 2 }, context)).toBe(true);
    expect(await browserTabs.approval!({ action: 'select', id: 2 }, context)).toMatchObject({
      key: `browser-open-as-you:${MAIL}`,
    });
    expect(await browserTabs.needsApproval!({ action: 'select', id: 1 }, context)).toBe(false);

    const listed = await browserTabs.run({ action: 'list' }, context);
    expect(listed).toContain(
      `- tab 2 (active): (signed in as the user; select it to read it, which asks them) - ${MAIL}`
    );
    expect(listed).not.toContain('token=abc');
  });

  it('takes no screenshot of a signed-in page without consent', async () => {
    const page = pageThatReads(INBOX);
    const { context, images, media } = signedIn(page);
    expect(await browserScreenshot.needsApproval!({}, context)).toBe(true);
    const result = await browserScreenshot.run({}, context);
    expect(result).toContain('Took no screenshot.');
    expect(images).toEqual([]);
    expect(media).toEqual([]);

    const allowed = signedIn(page, { approvedKey: `browser-open-as-you:${MAIL}` });
    await browserScreenshot.run({}, allowed.context);
    expect(allowed.images).toHaveLength(1);
  });

  /** capturePage paints every frame, so a local page can frame the signed-in site the snapshot cannot see into. */
  describe('a page that frames a signed-in site', () => {
    const LOCAL = 'http://localhost:3000/';

    function framing(subframe: string) {
      const page = pageThatReads(LOCAL);
      vi.mocked(page.frameUrls).mockReturnValue([LOCAL, subframe]);
      return page;
    }

    it('takes no screenshot of it without consent, naming only the framed origin', async () => {
      const page = framing(INBOX);
      const { context, images, media } = signedIn(page);
      expect(await browserScreenshot.needsApproval!({}, context)).toBe(false);
      const result = await browserScreenshot.run({}, context);
      expect(result).toContain('Took no screenshot.');
      expect(result).toContain(`The page embeds ${MAIL},`);
      expect(result).toContain(`browser_navigate on ${MAIL}`);
      expect(result).not.toContain('token=abc');
      expect(result).not.toContain('123456');
      expect(images).toEqual([]);
      expect(media).toEqual([]);
    });

    it('takes no screenshot when the frame reaches the signed-in site during the capture', async () => {
      const page = pageThatReads(LOCAL);
      vi.mocked(page.screenshot).mockImplementation(async () => {
        vi.mocked(page.frameUrls).mockReturnValue([LOCAL, INBOX]);
        return Buffer.from('png');
      });
      const { context, images } = signedIn(page);
      expect(await browserScreenshot.run({}, context)).toContain(`The page embeds ${MAIL},`);
      expect(images).toEqual([]);
    });

    it('takes it once the user allowed that site standing', async () => {
      const page = framing(INBOX);
      const { context, images } = signedIn(page, { isStanding: key => key === `browser-open-as-you:${MAIL}` });
      expect(await browserScreenshot.run({}, context)).toContain(`Captured a screenshot of ${LOCAL}`);
      expect(images).toHaveLength(1);
    });

    it('takes it when the framed site is not one the user is signed in to', async () => {
      const page = framing('https://www.youtube.com/embed/abc');
      const { context, images } = signedIn(page);
      expect(await browserScreenshot.run({}, context)).toContain(`Captured a screenshot of ${LOCAL}`);
      expect(images).toHaveLength(1);
    });
  });
});
