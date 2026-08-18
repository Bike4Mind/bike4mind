import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../widget';

/**
 * The comment overlay is served as a plain JS string, so these tests drive the handler to get
 * the real payload and then execute it in jsdom.
 *
 * Focus: the launcher/panel must clear the wrapper's bottom livery bar (.b4m-bar), which is
 * fixed at z-index 2147483647 - the maximum - so the widget cannot stack above it and has to
 * sit clear of it instead. jsdom does no layout, so we assert the offset MECHANISM (the
 * --b4m-chrome custom property and the rules that consume it) rather than pixel geometry.
 */
function getWidgetJs(): string {
  let body = '';
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn((b: string) => {
      body = b;
    }),
  };
  handler({} as never, res as never);
  return body;
}

/** Give an element a non-zero height; jsdom's own getBoundingClientRect is all zeros. */
function stubHeight(el: Element, height: number): void {
  el.getBoundingClientRect = () => ({ height }) as DOMRect;
}

function runWidget(): void {
  new Function(getWidgetJs())();
}

function chromeVar(): string {
  return document.documentElement.style.getPropertyValue('--b4m-chrome');
}

describe('publish comment widget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ annotations: [], canComment: false }),
        })
      )
    );
    document.head.innerHTML = '';
    document.documentElement.style.removeProperty('--b4m-chrome');
    document.body.innerHTML =
      '<iframe></iframe>' +
      '<div id="b4m-annotate-root" data-public-id="abc123" data-comment-policy="open" data-title="T"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offsets the launcher and panel by the livery-bar height instead of a bare 20px', () => {
    const css = getWidgetJs();
    // Both must consume --b4m-chrome; a regression to `bottom:20px` buries them under the bar.
    expect(css).toContain('#b4m-ov{position:fixed;z-index:2147483000;bottom:calc(20px + var(--b4m-chrome,0px))');
    expect(css).toContain('#b4m-panel{position:fixed;z-index:2147483000;bottom:calc(20px + var(--b4m-chrome,0px))');
    // The panel must also shrink by the bar height, else a full thread overflows past the top.
    expect(css).toContain('max-height:min(640px,calc(100vh - 40px - var(--b4m-chrome,0px)))');
  });

  it('measures the livery bar and exposes it as --b4m-chrome', () => {
    const bar = document.createElement('div');
    bar.className = 'b4m-bar';
    document.body.appendChild(bar);
    stubHeight(bar, 52);

    runWidget();

    expect(chromeVar()).toBe('52px');
  });

  it('falls back to a zero offset when the page renders no livery bar', () => {
    runWidget();

    expect(chromeVar()).toBe('0px');
  });

  it('re-measures on resize, since the bar wraps taller on narrow viewports', () => {
    const bar = document.createElement('div');
    bar.className = 'b4m-bar';
    document.body.appendChild(bar);
    stubHeight(bar, 52);

    runWidget();
    expect(chromeVar()).toBe('52px');

    stubHeight(bar, 84);
    window.dispatchEvent(new Event('resize'));

    expect(chromeVar()).toBe('84px');
  });

  it('bypasses the HTTP cache on the initial list load but not on polls', () => {
    runWidget();

    const listCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      c => !String(c[0]).endsWith('/can-comment')
    );
    // A reload wipes the in-memory justPosted guard, so a cached pre-comment body
    // would make the viewer's own fresh comment appear to vanish.
    expect(listCall?.[1]).toMatchObject({ cache: 'no-store' });
  });

  it('mounts the launcher and panel', () => {
    runWidget();

    expect(document.getElementById('b4m-ov')).not.toBeNull();
    expect(document.getElementById('b4m-panel')).not.toBeNull();
  });

  it('scopes the sans-serif font to the panel, which is appended to body not #b4m-ov', () => {
    const css = getWidgetJs();
    // The panel and hint live outside #b4m-ov, so the font rule must name them or they
    // fall back to the host page's default serif (buttons hide it via a UA sans default).
    const fontRule = css.split('\n').find(line => line.includes('font-family:ui-sans-serif'));
    expect(fontRule).toBeDefined();
    expect(fontRule).toContain('#b4m-panel');
    expect(fontRule).toContain('#b4m-panel *');
  });
});

/**
 * Behavioural tests that need the panel actually open and rendered, driven through the
 * real DOM the widget builds. The fetch mock below is scriptable per test so a poll can
 * be made to return a STALE list (the state that exposes the pending-comment bug) and
 * responses can carry a Date header (which drives the clock-skew correction).
 */
interface StubResponse {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  json: () => Promise<unknown>;
}

function jsonRes(body: unknown, status = 200, dateMs?: number): StubResponse {
  return {
    ok: status < 400,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'date' && dateMs != null ? new Date(dateMs).toUTCString() : null),
    },
    json: () => Promise.resolve(body),
  };
}

interface Comment {
  id: string;
  authorDisplayName: string;
  body: string;
  createdAt: string;
  resolvedAt: string | null;
}

function installFetch(opts: {
  list: () => Comment[];
  canComment: boolean;
  serverDateMs?: number;
  onPost?: () => Comment;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: { method?: string }) => {
      const u = String(url);
      if (u.endsWith('/can-comment')) {
        return Promise.resolve(jsonRes({ commentPolicy: 'open', canComment: opts.canComment }));
      }
      if (init?.method === 'POST') return Promise.resolve(jsonRes(opts.onPost!(), 201));
      return Promise.resolve(jsonRes({ annotations: opts.list(), commentPolicy: 'open' }, 200, opts.serverDateMs));
    })
  );
}

/** Let the widget's fetch chains settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
const listText = () => document.getElementById('b4m-list')?.textContent ?? '';

// The boot call to loop() schedules the first poll while the panel is still closed, so
// it lands at the 60s (closed) cadence even if the panel is opened immediately after.
const FIRST_POLL_MS = 60000;

describe('publish comment widget - rendered behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = '';
    document.documentElement.style.removeProperty('--b4m-chrome');
    document.body.innerHTML =
      '<iframe></iframe>' +
      '<div id="b4m-annotate-root" data-public-id="abc123" data-comment-policy="open" data-title="T"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps every just-posted comment when a poll returns a list that predates them', async () => {
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    let posted = 0;
    installFetch({
      // The server list never catches up - exactly what a cached/stale poll looks like.
      list: () => [],
      canComment: true,
      onPost: () => {
        posted += 1;
        return {
          id: 'c' + posted,
          authorDisplayName: 'Me',
          body: 'body ' + posted,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        };
      },
    });

    runWidget();
    await flush();
    click('b4m-launch');
    await flush();

    // Two comments inside one poll window. A single-slot guard protects only the second.
    for (const text of ['first', 'second']) {
      (document.getElementById('b4m-ta') as HTMLTextAreaElement).value = text;
      click('b4m-send');
      await flush();
    }

    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);

    expect(listText()).toContain('body 1');
    expect(listText()).toContain('body 2');
  });

  it('stops protecting a posted comment once it ages out', async () => {
    vi.setSystemTime(Date.parse('2026-01-01T00:00:00.000Z'));
    installFetch({
      list: () => [],
      canComment: true,
      onPost: () => ({
        id: 'c1',
        authorDisplayName: 'Me',
        body: 'orphan',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      }),
    });

    runWidget();
    await flush();
    click('b4m-launch');
    await flush();
    (document.getElementById('b4m-ta') as HTMLTextAreaElement).value = 'orphan';
    click('b4m-send');
    await flush();

    // Still held over the first poll - it may legitimately just be a stale list.
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    expect(listText()).toContain('orphan');

    // Past PENDING_TTL_MS with the server list still empty: the local copy is dropped
    // rather than resurrected forever (e.g. it was deleted before it ever appeared).
    await vi.advanceTimersByTimeAsync(300000);
    expect(listText()).not.toContain('orphan');
  });

  it('renders ages against the server clock, not a skewed client clock', async () => {
    const clientNow = Date.parse('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(clientNow);
    const serverNow = clientNow + 3 * 3600_000; // the browser's clock runs 3h behind
    const twoHoursOld = new Date(serverNow - 2 * 3600_000).toISOString();

    installFetch({
      list: () => [{ id: 'a1', authorDisplayName: 'Bob', body: 'hi', createdAt: twoHoursOld, resolvedAt: null }],
      canComment: false,
      serverDateMs: serverNow,
    });

    runWidget();
    await flush();
    click('b4m-launch');
    await flush();

    // Uncorrected, client-now minus createdAt is negative and clamps to "just now".
    expect(listText()).toContain('2h ago');
    expect(listText()).not.toContain('just now');
  });
});
