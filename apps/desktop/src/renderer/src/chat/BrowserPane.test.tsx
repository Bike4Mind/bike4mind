// @vitest-environment jsdom
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserFreezeFrameRequest,
  BrowserPageStateEvent,
  BrowserPaneBounds,
  BrowserPaneRequest,
  BrowserPaneState,
  BrowserTabRequest,
} from '@shared/ipc';
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
  tabs: [
    { id: 1, title: 'Example Domain', url: 'https://example.com/', loading: false },
    { id: 4, title: '', url: '', loading: false },
  ],
  activeTabId: 1,
};

const STILL = 'data:image/jpeg;base64,c3RpbGw=';

const setPane = vi.fn<(request: BrowserPaneRequest) => Promise<BrowserPaneState>>();
const tab = vi.fn<(request: BrowserTabRequest) => Promise<BrowserPaneState>>();
const freezeFrame = vi.fn<(request: BrowserFreezeFrameRequest) => Promise<string | null>>();
let pageState: ((event: BrowserPageStateEvent) => void) | null = null;
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
        <BrowserPane
          sessionId="s1"
          suspended={false}
          conversation={conversation}
          historyEnabled={null}
          onHistory={() => undefined}
        />
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
  tab.mockReset();
  tab.mockResolvedValue(PAGE);
  freezeFrame.mockReset();
  freezeFrame.mockResolvedValue(STILL);
  pageState = null;
  (window as unknown as { b4m: unknown }).b4m = {
    browser: {
      setPane,
      freezeFrame,
      navigate: vi.fn(),
      go: vi.fn(),
      tab,
      onPageState: (listener: (event: BrowserPageStateEvent) => void) => {
        pageState = listener;
        return () => {};
      },
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
            <BrowserPane
              sessionId="s1"
              suspended={suspended}
              conversation={conversation}
              historyEnabled={null}
              onHistory={() => undefined}
            />
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

  it('does not store a click on the handle over a wider width chosen on a bigger window', () => {
    window.localStorage.setItem('b4m.browserPane.width', '800');
    setViewport(1400);
    mount();
    expect(paneWidth()).toBe(588);
    press(800);
    release();
    expect(window.localStorage.getItem('b4m.browserPane.width')).toBe('800');
    expect(setPane).not.toHaveBeenCalledWith(expect.objectContaining({ bounds: null }));
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

describe('the browser pane tab strip', () => {
  const tabs = () => [...(host?.querySelectorAll<HTMLElement>('[data-testid="browser-tab-select-btn"]') ?? [])];
  const address = () => host?.querySelector<HTMLInputElement>('[data-testid="chat-browser-url"]') ?? null;
  const settled = () => act(async () => undefined);
  const key = (target: HTMLElement | null, code: string, shiftKey = false) =>
    act(() => {
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { code, shiftKey, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })
      );
    });

  it('draws each tab with the active one selected, and a blank one as a new tab', async () => {
    mount();
    await settled();
    expect(tabs().map(element => [element.textContent, element.getAttribute('aria-selected')])).toEqual([
      ['Example Domain', 'true'],
      ['New tab', 'false'],
    ]);
  });

  it('switches on a click, and closes on the close button or a middle-click without switching', async () => {
    mount();
    await settled();

    act(() => tabs()[1].click());
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'select', tabId: 4 });

    act(() => tabs()[1].querySelector<HTMLElement>('[data-testid="browser-tab-close-btn"]')?.click());
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'close', tabId: 4 });
    expect(tab).toHaveBeenCalledTimes(2);

    act(() => {
      tabs()[0].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    });
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'close', tabId: 1 });
  });

  it('opens a tab from the plus and puts the cursor in the address', async () => {
    mount();
    await settled();

    act(() => host?.querySelector<HTMLElement>('[data-testid="browser-tab-new-btn"]')?.click());

    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'new', tabId: undefined });
    expect(document.activeElement).toBe(address());
  });

  it('takes the tab shortcuts while focus is in the pane, and swallows them', async () => {
    mount();
    await settled();
    const field = address();

    key(field, 'BracketRight', true);
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'select', tabId: 4 });
    key(field, 'BracketLeft', true);
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'select', tabId: 4 });
    key(field, 'KeyW');
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'close', tabId: 1 });
    key(field, 'KeyT');
    expect(tab).toHaveBeenLastCalledWith({ sessionId: 's1', action: 'new', tabId: undefined });

    const plain = new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true });
    act(() => {
      field?.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(tab).toHaveBeenCalledTimes(4);
  });

  it('says the conversation has no tabs once the last one closed', async () => {
    setPane.mockResolvedValue({ ...PAGE, url: '', tabs: [], activeTabId: null });
    mount();
    await settled();

    expect(tabs()).toEqual([]);
    expect(host?.querySelector('[data-testid="chat-browser-pane-empty"]')?.textContent).toBe(
      "This conversation's browser has no tabs open."
    );
  });
});

describe('the browser pane under overlays', () => {
  const layers: HTMLElement[] = [];
  /** Over the bottom-left of the page's hole, the way the context ring's tooltip reached it. */
  const overPage = rect(1300, 300, 700, 40);

  /** A portalled layer as Joy appends it to the body; the observer hears it on a microtask. */
  const portal = async (role: string, html: string) => {
    const layer = document.createElement('div');
    layer.setAttribute('role', role);
    layer.innerHTML = html;
    layer.getBoundingClientRect = () => overPage;
    await act(async () => {
      document.body.appendChild(layer);
    });
    flushFrames();
    layers.push(layer);
    return layer;
  };
  const remove = async (layer: HTMLElement) => {
    await act(async () => layer.remove());
    flushFrames();
    await act(async () => undefined);
  };
  const still = () => host?.querySelector<HTMLImageElement>('[data-testid="chat-browser-pane-still"]') ?? null;
  /** Past the still's delay, with the capture's promise settled. */
  const waitForStill = () => act(() => vi.advanceTimersByTimeAsync(80));

  // In production the still's delay is a 50ms timer, and the awaited acts between a layer's coming
  // and going can take that long on a loaded runner. Only timeouts are faked: frames are scripted above.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const layer of layers.splice(0)) layer.remove();
  });

  it('keeps the page up under a tooltip that only shows text', async () => {
    mount();
    setPane.mockClear();
    await portal('tooltip', 'Context 27k / 400k');
    expect(setPane).not.toHaveBeenCalledWith(expect.objectContaining({ bounds: null }));
  });

  it('takes the page down under a menu over it', async () => {
    mount();
    setPane.mockClear();
    await portal('menu', '<li role="menuitem" tabindex="-1">GPT-5</li>');
    expect(lastBounds()).toBeNull();
  });

  it('draws a still of the page while it is held, and drops it once the page is back', async () => {
    mount();
    await act(async () => undefined);
    const menu = await portal('menu', '<li role="menuitem" tabindex="-1">GPT-5</li>');
    expect(still()).toBeNull();

    await waitForStill();
    expect(freezeFrame).toHaveBeenCalledTimes(1);
    expect(freezeFrame).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(still()?.getAttribute('src')).toBe(STILL);

    await remove(menu);
    expect(lastBounds()).not.toBeNull();
    expect(still()).toBeNull();
  });

  it('asks for no still when the page is back within the delay', async () => {
    mount();
    const menu = await portal('menu', '<li role="menuitem" tabindex="-1">GPT-5</li>');
    await remove(menu);
    await waitForStill();
    expect(freezeFrame).not.toHaveBeenCalled();
    expect(still()).toBeNull();
  });

  it('drops the still when the active tab changes underneath it', async () => {
    mount();
    await act(async () => undefined);
    await portal('menu', '<li role="menuitem" tabindex="-1">GPT-5</li>');
    await waitForStill();
    expect(still()).not.toBeNull();

    act(() => pageState?.({ ...PAGE, activeTabId: 4, sessionId: 's1' }));
    expect(still()).toBeNull();
  });
});
