// @vitest-environment jsdom
//
// EXECUTION coverage for same-bundle link routing. The static tests assert the scripts' shape;
// only running them shows that a click really reaches the parent and that the parent refuses
// to navigate anywhere outside the bundle it is showing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildFragmentNavScriptTag, HASH_BRIDGE_JS } from './fragmentNav';

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
    ['an absolute URL', `https://elsewhere.example${BASE}/report.pdf`],
    ['a protocol-relative URL', `//elsewhere.example${BASE}/report.pdf`],
    ['a non-string', 42],
  ])('refuses %s', (_label, path) => {
    runParentBridge(BASE);
    fromFrame({ b4m: 'navigate', path });
    expect(fetchDownload).not.toHaveBeenCalled();
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
