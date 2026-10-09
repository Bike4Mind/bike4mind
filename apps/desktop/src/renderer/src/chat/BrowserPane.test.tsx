// @vitest-environment jsdom
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPaneBounds, BrowserPaneRequest, BrowserPaneState } from '@shared/ipc';
import { BROWSER_PANE_WIDTH } from './agentBrowser';
import { BrowserPane } from './BrowserPane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

/**
 * The layout jsdom does not do: a row as wide as the window less a 400px sidebar, split between
 * the conversation (flex: 1) and the pane (its inline width), with the page's hole filling the
 * pane below a 40px navbar.
 */
let sidebar = 400;
const NAVBAR = 40;

const PAGE: BrowserPaneState = {
  url: 'https://example.com/',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: '',
};

const setPane = vi.fn<(request: BrowserPaneRequest) => Promise<BrowserPaneState>>();
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** Every live ResizeObserver's callback; jsdom has no layout to fire them from. */
const observers = new Set<() => void>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let conversation: RefObject<HTMLDivElement | null>;

const paneElement = () => host?.querySelector<HTMLElement>('[data-testid="chat-browser-pane"]') ?? null;
const handle = () => host?.querySelector<HTMLElement>('[data-testid="browser-resize-handle"]') ?? null;
const paneWidth = () => Number.parseFloat(paneElement()?.style.width ?? '');
const rowWidth = () => window.innerWidth - sidebar;

function rect(x: number, width: number, y = 0, height = 800): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

/** What a real width change does: a frame for the write, then the observers after layout. */
function runFrameAndResizes() {
  const due = [...frames.values()];
  frames = new Map();
  for (const callback of due) callback(0);
  for (const fire of observers) fire();
}

function flushFrames() {
  act(() => {
    for (let round = 0; round < 20 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames = new Map();
      for (const callback of due) callback(0);
    }
  });
}

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider>
        <BrowserPane sessionId="s1" suspended={false} conversation={conversation} />
      </CssVarsProvider>
    )
  );
  flushFrames();
}

const pointer = (type: string, clientX: number) => new MouseEvent(type, { bubbles: true, clientX, button: 0 });

function press(x: number) {
  act(() => {
    handle()?.dispatchEvent(pointer('pointerdown', x));
  });
}

function move(x: number) {
  act(() => {
    window.dispatchEvent(pointer('pointermove', x));
  });
}

function release(type: 'pointerup' | 'pointercancel' = 'pointerup') {
  act(() => {
    window.dispatchEvent(pointer(type, 0));
  });
  flushFrames();
}

const boundsSent = () => setPane.mock.calls.map(([request]) => request.bounds);
const lastBounds = (): BrowserPaneBounds | null | undefined => boundsSent().at(-1);

beforeEach(() => {
  setViewport(2000);
  sidebar = 400;
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly fire: () => void;
      constructor(callback: () => void) {
        this.fire = () => callback();
        observers.add(this.fire);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        observers.delete(this.fire);
      }
    }
  );

  const column = document.createElement('div');
  column.getBoundingClientRect = () => rect(sidebar, rowWidth() - paneWidth());
  conversation = createRef<HTMLDivElement | null>() as RefObject<HTMLDivElement | null>;
  conversation.current = column;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pane = this.closest<HTMLElement>('[data-testid="chat-browser-pane"]');
    if (!pane) return rect(0, 0, 0, 0);
    const width = Number.parseFloat(pane.style.width);
    if (this === pane) return rect(window.innerWidth - width, width);
    return rect(window.innerWidth - width, width, NAVBAR, 800 - NAVBAR);
  });

  setPane.mockReset();
  setPane.mockResolvedValue(PAGE);
  (window as unknown as { b4m: unknown }).b4m = {
    browser: {
      setPane,
      navigate: vi.fn(),
      go: vi.fn(),
      onPageState: () => () => {},
      cookies: {
        getState: () => Promise.resolve({ supported: false, unsupported: '', sites: [] }),
        onChanged: () => () => {},
      },
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  observers.clear();
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('the browser pane resize handle', () => {
  it('is labelled for assistive tech', () => {
    mount();
    expect(handle()?.getAttribute('aria-label')).toBe('Resize browser');
    expect(handle()?.getAttribute('role')).toBe('separator');
  });

  it('follows a leftward drag wider, and holds it inside the clamps', () => {
    mount();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH);

    press(1440);
    move(1240);
    flushFrames();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 200);

    // 42% of a 2000px window, well inside what the conversation can give up.
    move(0);
    flushFrames();
    expect(paneWidth()).toBe(840);

    move(2000);
    flushFrames();
    expect(paneWidth()).toBe(320);

    release();
    expect(paneWidth()).toBe(320);
  });

  it('applies the width on the next frame, with the latest of however many moves arrived before it', () => {
    mount();
    press(1440);
    for (let x = 1439; x >= 1300; x--) move(x);
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH);
    flushFrames();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 140);
    release();
  });

  it('takes the page off the window for the drag and puts it back once, at the final size, on release', () => {
    mount();
    expect(lastBounds()).toEqual({ x: 2000 - BROWSER_PANE_WIDTH, y: NAVBAR, width: BROWSER_PANE_WIDTH, height: 760 });
    setPane.mockClear();

    press(1440);
    // A press alone is not a drag: the page stays where it is.
    expect(setPane).not.toHaveBeenCalled();

    for (let x = 1435; x >= 1200; x -= 5) {
      move(x);
      act(runFrameAndResizes);
    }
    expect(boundsSent()).toEqual([null]);

    release();
    const finalWidth = BROWSER_PANE_WIDTH + 240;
    expect(paneWidth()).toBe(finalWidth);
    expect(boundsSent()).toEqual([null, { x: 2000 - finalWidth, y: NAVBAR, width: finalWidth, height: 760 }]);
  });

  // The first width lands on a frame, and a frame can come before React renders anything the
  // move asked for; the page must already be down by then rather than follow it once.
  it('stands the page down before the first width of a drag can reach it', () => {
    mount();
    setPane.mockClear();
    press(1440);
    act(() => {
      window.dispatchEvent(pointer('pointermove', 1400));
      runFrameAndResizes();
    });
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 40);
    expect(boundsSent()).toEqual([null]);
    release();
  });

  it('stands down and comes back with the drop overlay without tearing the page off in between', () => {
    mount();
    setPane.mockClear();
    const render = (suspended: boolean) =>
      act(() =>
        root?.render(
          <CssVarsProvider>
            <BrowserPane sessionId="s1" suspended={suspended} conversation={conversation} />
          </CssVarsProvider>
        )
      );
    render(true);
    flushFrames();
    expect(setPane.mock.calls.map(([request]) => request)).toEqual([{ sessionId: 's1', bounds: null }]);
    render(false);
    flushFrames();
    expect(boundsSent()).toEqual([
      null,
      { x: 2000 - BROWSER_PANE_WIDTH, y: NAVBAR, width: BROWSER_PANE_WIDTH, height: 760 },
    ]);
  });

  it('puts the page back when the drag is cancelled rather than released', () => {
    mount();
    setPane.mockClear();
    press(1440);
    move(1340);
    flushFrames();
    expect(lastBounds()).toBeNull();

    release('pointercancel');
    expect(lastBounds()).toMatchObject({ width: BROWSER_PANE_WIDTH + 100 });
    expect(document.body.style.cursor).toBe('');
  });

  it('remembers the width across a remount', () => {
    mount();
    press(1440);
    move(1340);
    release();
    expect(window.localStorage.getItem('b4m.browserPane.width')).toBe(String(BROWSER_PANE_WIDTH + 100));

    act(() => root?.unmount());
    host?.remove();
    mount();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 100);
  });

  it('opens at the default when storage is blocked, and a drag still works', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH);
    press(1440);
    move(1340);
    release();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 100);
  });

  it('goes back to the default on a double-click', () => {
    window.localStorage.setItem('b4m.browserPane.width', '800');
    mount();
    expect(paneWidth()).toBe(800);

    act(() => {
      handle()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    flushFrames();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH);
    expect(window.localStorage.getItem('b4m.browserPane.width')).toBe(String(BROWSER_PANE_WIDTH));
  });

  it('steps with the arrow keys, left being wider', () => {
    mount();
    act(() => {
      handle()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    flushFrames();
    expect(paneWidth()).toBe(BROWSER_PANE_WIDTH + 16);
  });

  it('narrows when the window shrinks, and comes back when it grows, without forgetting the choice', () => {
    window.localStorage.setItem('b4m.browserPane.width', '800');
    mount();
    expect(paneWidth()).toBe(800);

    setViewport(1400);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    flushFrames();
    // 42% of 1400.
    expect(paneWidth()).toBe(588);

    setViewport(2000);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    flushFrames();
    expect(paneWidth()).toBe(800);
    expect(window.localStorage.getItem('b4m.browserPane.width')).toBe('800');
  });

  it('leaves the conversation its minimum when the fixed columns are wide', () => {
    window.localStorage.setItem('b4m.browserPane.width', '800');
    sidebar = 900;
    mount();
    // 1100px between the pane and the conversation; the conversation keeps 400 of it.
    expect(paneWidth()).toBe(700);
  });
});
