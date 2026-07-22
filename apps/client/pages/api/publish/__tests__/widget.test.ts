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

  it('mounts the launcher and panel', () => {
    runWidget();

    expect(document.getElementById('b4m-ov')).not.toBeNull();
    expect(document.getElementById('b4m-panel')).not.toBeNull();
  });
});
