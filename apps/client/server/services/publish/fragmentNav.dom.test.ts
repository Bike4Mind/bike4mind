// @vitest-environment jsdom
//
// EXECUTION coverage for same-bundle link routing. The static tests assert the scripts' shape;
// only running them shows that a click really reaches the parent and that the parent refuses
// to navigate anywhere outside the bundle it is showing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildFragmentNavScriptTag, HASH_BRIDGE_JS } from './fragmentNav';
import { renderSandboxedBundle } from './renderSandboxedBundle';

const ORIGIN = window.location.origin;
const BASE = '/p/u/scope123/my-slug';

/**
 * jsdom keeps one window/document per file, so every listener a test adds is tracked and
 * removed afterwards - otherwise an earlier test's script still answers a later dispatch.
 */
let added: Array<[EventTarget, string, EventListener]> = [];
const nativeWindowAdd = window.addEventListener.bind(window);
const nativeDocumentAdd = document.addEventListener.bind(document);

beforeEach(() => {
  added = [];
  window.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    added.push([window, type, fn]);
    nativeWindowAdd(type, fn, opts);
  }) as typeof window.addEventListener;
  document.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    added.push([document, type, fn]);
    nativeDocumentAdd(type, fn, opts);
  }) as typeof document.addEventListener;
});

afterEach(() => {
  for (const [target, type, fn] of added) target.removeEventListener(type, fn);
  window.addEventListener = nativeWindowAdd as typeof window.addEventListener;
  document.addEventListener = nativeDocumentAdd as typeof document.addEventListener;
  document.body.innerHTML = '';
  delete (window as { __b4mFetchDownload?: unknown }).__b4mFetchDownload;
  vi.restoreAllMocks();
});

describe('fragment nav (in-frame) bundle-link routing', () => {
  function runFrameScript(bundleBases: string[]): void {
    const tag = buildFragmentNavScriptTag({ origins: [ORIGIN], paths: [`${BASE}/guide/intro.html`], bundleBases });
    // eval, deliberately: the shipped script is what must behave, not a reimplementation.
    eval(tag.slice('<script>'.length, -'</script>'.length));
  }

  function click(href: string, target?: string): MouseEvent {
    const a = document.createElement('a');
    a.href = href;
    if (target) a.target = target;
    a.textContent = 'link';
    document.body.appendChild(a);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    return ev;
  }

  it('hands a same-bundle page or file to the parent instead of navigating the frame', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    runFrameScript([BASE]);

    const page = click(`${ORIGIN}${BASE}/guide/next.html#s2`);
    expect(page.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith({ b4m: 'navigate', path: `${BASE}/guide/next.html#s2` }, '*');

    const file = click(`${ORIGIN}${BASE}/files/report.pdf`, '_blank');
    expect(file.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith({ b4m: 'navigate', path: `${BASE}/files/report.pdf` }, '*');

    const root = click(`${ORIGIN}${BASE}`);
    expect(root.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith({ b4m: 'navigate', path: BASE }, '*');
  });

  it("passes on only a file link's exact ?download=1 query", () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    runFrameScript([BASE]);

    click(`${ORIGIN}${BASE}/files/deck.pdf?download=1#p2`);
    click(`${ORIGIN}${BASE}/files/deck.pdf?download=1&x=2`);
    click(`${ORIGIN}${BASE}/guide/next.html?download=1`);
    expect(post.mock.calls.map(c => (c[0] as { path: string }).path)).toEqual([
      `${BASE}/files/deck.pdf?download=1#p2`,
      `${BASE}/files/deck.pdf`,
      `${BASE}/guide/next.html`,
    ]);
  });

  it('leaves a new-tab page link, other bundles and other origins to the browser', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    runFrameScript([BASE]);

    expect(click(`${ORIGIN}${BASE}/guide/next.html`, '_blank').defaultPrevented).toBe(false);
    expect(click(`${ORIGIN}/p/u/scope123/other-slug/page.html`).defaultPrevented).toBe(false);
    expect(click(`${ORIGIN}${BASE}-suffix/page.html`).defaultPrevented).toBe(false);
    expect(click(`https://elsewhere.example${BASE}/page.html`).defaultPrevented).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('routes nothing when no bundle base is configured (isolated origin)', () => {
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    runFrameScript([]);
    expect(click(`${ORIGIN}${BASE}/files/report.pdf`).defaultPrevented).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('hash bridge (parent) navigate handling', () => {
  let frame: HTMLIFrameElement;
  let fetchDownload: ReturnType<typeof vi.fn>;

  const setActivation = (isActive: boolean) =>
    Object.defineProperty(navigator, 'userActivation', { value: { isActive }, configurable: true });
  // Every case runs inside a click's activation unless it says otherwise.
  beforeEach(() => setActivation(true));
  afterEach(() => {
    delete (navigator as { userActivation?: unknown }).userActivation;
    vi.useRealTimers();
  });

  function runParentBridge(pathname: string): void {
    window.history.replaceState(null, '', pathname);
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    fetchDownload = vi.fn();
    (window as { __b4mFetchDownload?: unknown }).__b4mFetchDownload = fetchDownload;
    eval(HASH_BRIDGE_JS);
  }

  function fromFrame(data: unknown, source: Window | null = frame.contentWindow): void {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  }

  it('accepts a file under the bundle it is showing', () => {
    runParentBridge(`${BASE}/guide/intro.html`);
    fromFrame({ b4m: 'navigate', path: `${BASE}/files/report.pdf` });
    expect(fetchDownload).toHaveBeenCalledWith(`${BASE}/files/report.pdf`);
  });

  it("passes a file's ?download=1 on to the download hook", () => {
    runParentBridge(`${BASE}/guide/intro.html`);
    fromFrame({ b4m: 'navigate', path: `${BASE}/files/deck.pdf?download=1` });
    expect(fetchDownload).toHaveBeenCalledWith(`${BASE}/files/deck.pdf?download=1`);
  });

  it('navigates the top-level context to a page under the bundle, keeping its fragment', () => {
    runParentBridge(`${BASE}/guide/intro.html`);
    // jsdom performs only same-document navigations, so the target is this page plus a
    // fragment: the address bar changing proves `location.assign` ran.
    fromFrame({ b4m: 'navigate', path: `${BASE}/guide/intro.html#part-2` });
    expect(window.location.pathname + window.location.hash).toBe(`${BASE}/guide/intro.html#part-2`);
    expect(fetchDownload).not.toHaveBeenCalled();
  });

  it('accepts a file under a share-link bundle', () => {
    runParentBridge('/a/tok123');
    fromFrame({ b4m: 'navigate', path: '/a/tok123/files/report.pdf' });
    expect(fetchDownload).toHaveBeenCalledWith('/a/tok123/files/report.pdf');
  });

  it.each([
    ['another bundle', '/p/u/scope123/other-slug/report.pdf'],
    ['a prefix lookalike', `${BASE}-x/report.pdf`],
    ['a dot-dot segment', `${BASE}/../other-slug/report.pdf`],
    ['an encoded dot-dot segment', `${BASE}/%2e%2e/report.pdf`],
    ['an empty segment', `${BASE}//report.pdf`],
    ['a query string', `${BASE}/report.pdf?export=html`],
    ['a query string after ?download=1', `${BASE}/report.pdf?download=1&export=html`],
    ['?download=1 in the middle of the path', `${BASE}/report.pdf?download=1/x.pdf`],
    ['?download=1 on a page', `${BASE}/guide/next.html?download=1`],
    ['?download=1 on the bundle root', `${BASE}?download=1`],
    ['a query string in the fragment', `${BASE}/report.pdf#a?b`],
    ['an absolute URL', `https://elsewhere.example${BASE}/report.pdf`],
    ['a protocol-relative URL', `//elsewhere.example${BASE}/report.pdf`],
    ['a non-string', 42],
    // A URL parser folds these into `..`, so `/p/u/x/y/.%2e/.%2e/.%2e/.%2e/api` would be `/api`.
    ['a dot + encoded-dot segment', `${BASE}/.%2e/.%2e/.%2e/.%2e/api/users/me`],
    ['a dot + upper-case encoded-dot segment', `${BASE}/.%2E/.%2E/.%2E/.%2E/api/users/me`],
    ['an encoded-dot + dot segment', `${BASE}/%2e./%2e./%2e./%2e./api/users/me`],
    ['an encoded single-dot segment', `${BASE}/%2e/report.pdf`],
    ['a double-encoded dot-dot segment', `${BASE}/%252e%252e/report.pdf`],
    ['a double-encoded slash', `${BASE}/..%252fapi/report.pdf`],
    ['a double-encoded single dot', `${BASE}/%252e/report.pdf`],
    ['an encoded percent sign', `${BASE}/files/100%25.pdf`],
    ['an encoded slash', `${BASE}/..%2fapi/report.pdf`],
    ['a backslash', `${BASE}/..\\..\\api`],
    ['an encoded backslash', `${BASE}/..%5c..%5capi`],
    ['the bundle root with a trailing dot-dot', `${BASE}/..`],
    ['a whitespace character', `${BASE}/files/re port.pdf`],
  ])('refuses %s', (_label, path) => {
    runParentBridge(BASE);
    fromFrame({ b4m: 'navigate', path });
    expect(fetchDownload).not.toHaveBeenCalled();
  });

  describe('user activation', () => {
    const fakeClock = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    };
    const tick = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

    it('refuses to navigate without a user activation (a script looping navigate messages)', () => {
      setActivation(false);
      runParentBridge(BASE);
      fromFrame({ b4m: 'navigate', path: `${BASE}/files/report.pdf` });
      expect(fetchDownload).not.toHaveBeenCalled();
    });

    it('allows one file per activation window, not a burst within it', () => {
      fakeClock();
      runParentBridge(BASE);
      fromFrame({ b4m: 'navigate', path: `${BASE}/files/report.pdf` });
      tick(1500);
      fromFrame({ b4m: 'navigate', path: `${BASE}/files/other.pdf` });
      tick(1500);
      fromFrame({ b4m: 'navigate', path: `${BASE}/files/third.pdf` });
      expect(fetchDownload.mock.calls.map(c => c[0])).toEqual([`${BASE}/files/report.pdf`]);
      tick(5000);
      fromFrame({ b4m: 'navigate', path: `${BASE}/files/later.pdf` });
      expect(fetchDownload).toHaveBeenCalledTimes(2);
    });

    it('holds an active window to one navigation per second', () => {
      fakeClock();
      const page = `${BASE}/guide/intro.html`;
      runParentBridge(page);
      fromFrame({ b4m: 'navigate', path: `${page}#one` });
      tick(200);
      // Pages have no 5 s rule of their own, so only the one-per-second hold refuses this.
      fromFrame({ b4m: 'navigate', path: `${page}#two` });
      expect(window.location.hash).toBe('#one');
      tick(1000);
      fromFrame({ b4m: 'navigate', path: `${page}#three` });
      expect(window.location.hash).toBe('#three');
    });

    describe('without the activation API', () => {
      beforeEach(() => {
        delete (navigator as { userActivation?: unknown }).userActivation;
      });

      it('refuses every file navigation, since there is no click to require', () => {
        runParentBridge(BASE);
        fromFrame({ b4m: 'navigate', path: `${BASE}/files/report.pdf` });
        expect(fetchDownload).not.toHaveBeenCalled();
      });

      it('lets a page navigation through, at most one per 2 seconds', () => {
        fakeClock();
        const page = `${BASE}/guide/intro.html`;
        runParentBridge(page);
        fromFrame({ b4m: 'navigate', path: `${page}#one` });
        expect(window.location.hash).toBe('#one');
        tick(1500);
        fromFrame({ b4m: 'navigate', path: `${page}#two` });
        expect(window.location.hash).toBe('#one');
        tick(600);
        fromFrame({ b4m: 'navigate', path: `${page}#three` });
        expect(window.location.hash).toBe('#three');
      });
    });
  });

  it('ignores navigate messages that do not come from its own frame', () => {
    runParentBridge(BASE);
    fromFrame({ b4m: 'navigate', path: `${BASE}/files/report.pdf` }, window);
    expect(fetchDownload).not.toHaveBeenCalled();
  });

  it('does nothing on a page that is not a bundle viewer', () => {
    runParentBridge('/somewhere/else');
    fromFrame({ b4m: 'navigate', path: '/somewhere/else/report.pdf' });
    expect(fetchDownload).not.toHaveBeenCalled();
  });
});

describe('a rendered file link, end to end through the browser URL parser', () => {
  afterEach(() => {
    delete (navigator as { userActivation?: unknown }).userActivation;
  });

  /** Render the link as the server does, click it in the frame, and hand the posted path to the parent. */
  function route(fileName: string): { posted: unknown[]; fetchDownload: ReturnType<typeof vi.fn> } {
    window.history.replaceState(null, '', BASE);
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: `<html><body><a id="f" href="files/${fileName}">File</a></body></html>`,
      urlBase: BASE,
      origin: ORIGIN,
      visibility: 'private',
      pagePaths: [BASE],
      routeBundleLinks: true,
    });
    const rendered = new DOMParser().parseFromString(srcdoc, 'text/html');
    const link = rendered.getElementById('f');
    const navigationScript = Array.from(rendered.scripts).find(script => script.textContent.includes("b4m:'navigate'"));
    if (!link || !navigationScript) throw new Error('rendered bundle is missing its link or navigation script');
    const posted: unknown[] = [];
    vi.spyOn(window.parent, 'postMessage').mockImplementation((data: unknown) => {
      posted.push(data);
    });
    eval(navigationScript.textContent);
    document.body.appendChild(link);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const fetchDownload = vi.fn();
    (window as { __b4mFetchDownload?: unknown }).__b4mFetchDownload = fetchDownload;
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
    eval(HASH_BRIDGE_JS);
    for (const data of posted) window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
    return { posted, fetchDownload };
  }

  it.each([
    ['My Report (final).pdf', 'My%20Report%20(final).pdf'],
    ['\u65e5\u672c\u8a9e.pdf', '%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf'],
  ])('opens a file whose name needs percent-encoding: %s', (fileName, encodedName) => {
    const { posted, fetchDownload } = route(fileName);
    expect(posted).toEqual([{ b4m: 'navigate', path: `${BASE}/files/${encodedName}` }]);
    expect(fetchDownload).toHaveBeenCalledWith(`${BASE}/files/${encodedName}`);
  });

  it.each([
    ['100%-test.pdf', '100%25-test.pdf'],
    ['100%-done/report.pdf', '100%25-done/report.pdf'],
    ['100%2520done.pdf', '100%2520done.pdf'],
  ])('refuses a percent sign in a file or folder name: %s', (fileName, encodedName) => {
    const { posted, fetchDownload } = route(fileName);
    expect(posted).toEqual([{ b4m: 'navigate', path: `${BASE}/files/${encodedName}` }]);
    expect(fetchDownload).not.toHaveBeenCalled();
  });
});
