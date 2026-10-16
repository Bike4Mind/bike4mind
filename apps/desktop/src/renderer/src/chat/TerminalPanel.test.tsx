// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { TerminalDataEvent, TerminalInfo, TerminalsChangedEvent } from '@shared/terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { TerminalPanel } from './TerminalPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    written: string[] = [];
    opened: HTMLElement | null = null;
    disposed = false;
    focused = 0;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    inputListener: ((data: string) => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    open(element: HTMLElement) {
      this.opened = element;
    }
    onData(listener: (data: string) => void) {
      this.inputListener = listener;
      return { dispose: () => (this.inputListener = null) };
    }
    write(data: string) {
      this.written.push(data);
    }
    focus() {
      this.focused++;
    }
    dispose() {
      this.disposed = true;
    }
  }
  const links: { handler: ((event: MouseEvent, uri: string) => void) | null } = { handler: null };
  return { FakeTerminal, links };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      xterm.links.handler = handler;
    }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

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

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SHELL: TerminalInfo = { id: 't1', sessionId: 's1', title: 'zsh', cwd: '/repo', generation: 0, exit: null };

let root: Root | null = null;
let host: HTMLElement | null = null;
let listed: TerminalInfo[];
let dataListener: ((event: TerminalDataEvent) => void) | null;
let changedListener: ((event: TerminalsChangedEvent) => void) | null;
let bridge: {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onData: (listener: (event: TerminalDataEvent) => void) => () => void;
  onChanged: (listener: (event: TerminalsChangedEvent) => void) => () => void;
};

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  xterm.links.handler = null;
  listed = [];
  dataListener = null;
  changedListener = null;
  bridge = {
    list: vi.fn(async () => listed),
    create: vi.fn(async () => ({ ok: true, terminal: SHELL })),
    attach: vi.fn(async () => ({ terminal: SHELL, replay: 'earlier output' })),
    detach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    restart: vi.fn(async () => ({ ...SHELL, generation: 1 })),
    close: vi.fn(async () => undefined),
    onData: listener => {
      dataListener = listener;
      return () => (dataListener = null);
    },
    onChanged: listener => {
      changedListener = listener;
      return () => (changedListener = null);
    },
  };
  (window as unknown as { b4m: unknown }).b4m = { terminal: bridge };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const el = (testId: string) => {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

/** Flushes effects, and waits out the lazy import of the screen on its first load. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
  await vi.waitFor(async () => {
    await act(async () => undefined);
    if (document.querySelector('[data-testid="terminal-panel-status"]')) return;
    if (!document.querySelector('[data-testid="terminal-view-screen"]')) throw new Error('screen not mounted yet');
  });
}

async function renderPanel(
  props: { onHide?: () => void; onOpenLink?: (url: string) => void; focusRequest?: number } = {}
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const column = createRef<HTMLDivElement>();
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <div ref={column}>
          <TerminalPanel
            sessionId="s1"
            column={column}
            focusRequest={props.focusRequest ?? 0}
            onHide={props.onHide ?? (() => undefined)}
            onOpenLink={props.onOpenLink ?? (() => undefined)}
          />
        </div>
      </CssVarsProvider>
    );
  });
  await settle();
}

describe('TerminalPanel', () => {
  it('starts a shell when opened on a conversation with none, and mounts xterm on it', async () => {
    await renderPanel({ focusRequest: 1 });

    expect(bridge.create).toHaveBeenCalledWith({ sessionId: 's1', cols: 80, rows: 24 });
    const [term] = xterm.FakeTerminal.instances;
    expect(term.opened).toBe(el('terminal-view-screen'));
    expect(term.options.scrollback).toBe(5_000);
    expect(bridge.attach).toHaveBeenCalledWith('t1');
    expect(term.written).toEqual(['earlier output']);
    expect(term.focused).toBeGreaterThan(0);
  });

  it('reuses a running shell instead of starting another', async () => {
    listed = [SHELL];
    await renderPanel();
    expect(bridge.create).not.toHaveBeenCalled();
    expect(xterm.FakeTerminal.instances).toHaveLength(1);
  });

  it('streams output in and keystrokes out', async () => {
    listed = [SHELL];
    await renderPanel();
    const [term] = xterm.FakeTerminal.instances;
    act(() => dataListener?.({ terminalId: 't1', data: 'more' }));
    act(() => dataListener?.({ terminalId: 'other', data: 'not mine' }));
    expect(term.written).toEqual(['earlier output', 'more']);
    term.inputListener?.('ls\r');
    expect(bridge.write).toHaveBeenCalledWith('t1', 'ls\r');
  });

  it('lets Ctrl+` through to the window rather than typing it', async () => {
    listed = [SHELL];
    await renderPanel();
    const [term] = xterm.FakeTerminal.instances;
    const toggle = new KeyboardEvent('keydown', { code: 'Backquote', ctrlKey: true });
    expect(term.keyHandler?.(toggle)).toBe(false);
    expect(term.keyHandler?.(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true }))).toBe(true);
  });

  it('opens links in the in-app browser', async () => {
    listed = [SHELL];
    const onOpenLink = vi.fn();
    await renderPanel({ onOpenLink });
    xterm.links.handler?.(new MouseEvent('click'), 'http://localhost:3000/');
    expect(onOpenLink).toHaveBeenCalledWith('http://localhost:3000/');
  });

  it('shows an exited shell with a restart that remounts the screen', async () => {
    listed = [SHELL];
    await renderPanel();
    act(() => changedListener?.({ sessionId: 's1', terminals: [{ ...SHELL, exit: { code: 1, signal: null } }] }));
    expect(el('terminal-exit-banner').textContent).toContain('exited with code 1');

    await act(async () => el('terminal-exit-restart-btn').click());
    await settle();
    expect(bridge.restart).toHaveBeenCalledWith('t1');
    expect(xterm.FakeTerminal.instances).toHaveLength(2);
    expect(xterm.FakeTerminal.instances[0].disposed).toBe(true);
    expect(bridge.detach).toHaveBeenCalledWith('t1');
    expect(document.querySelector('[data-testid="terminal-exit-banner"]')).toBeNull();
  });

  it('hides the panel when its last tab is closed', async () => {
    listed = [SHELL];
    const onHide = vi.fn();
    await renderPanel({ onHide });
    await act(async () => el('terminal-tab-close-btn').click());
    expect(onHide).toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalledWith('t1');
  });

  it('says why a shell could not start, with a retry', async () => {
    bridge.create.mockResolvedValueOnce({ ok: false, error: 'Could not start a shell: nope' });
    await renderPanel();
    expect(el('terminal-panel-status').textContent).toBe('Could not start a shell: nope');
    await act(async () => el('terminal-panel-retry-btn').click());
    await settle();
    expect(xterm.FakeTerminal.instances).toHaveLength(1);
  });

  it('grows upward from its top edge and remembers the height', async () => {
    listed = [SHELL];
    await renderPanel();
    const handle = el('terminal-resize-handle');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    const before = Number(handle.getAttribute('aria-valuenow'));
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(Number(el('terminal-resize-handle').getAttribute('aria-valuenow'))).toBe(before + 16);
    expect(el('terminal-panel').style.height).toBe(`${before + 16}px`);
    expect(window.localStorage.getItem('b4m.terminalPanel.height')).toBe(String(before + 16));
  });

  it('is drawn inside the app root, so the browser page never counts it as an overlay', async () => {
    listed = [SHELL];
    await renderPanel();
    expect(host?.contains(el('terminal-panel'))).toBe(true);
    expect(Array.from(document.body.children)).toEqual([host]);
  });
});
