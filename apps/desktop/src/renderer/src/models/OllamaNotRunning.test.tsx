// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ModelServerLaunchView, ModelServerMutationResult } from '@shared/modelServers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { OLLAMA_NOT_RUNNING, OLLAMA_START_HINT } from './localRuntimeCopy';
import { ComposerOllamaNotice, OllamaNotRunning, START_WAIT_MS, STARTED_SHOW_MS } from './OllamaNotRunning';

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

function launchView(extra: Partial<ModelServerLaunchView> = {}): ModelServerLaunchView {
  return {
    runtime: 'ollama',
    owner: 'none',
    busy: null,
    settings: {},
    pendingRestart: false,
    canStart: true,
    problem: null,
    observed: null,
    sizingKvCacheType: 'f16',
    sizingFlashAttention: 'auto',
    prefill: null,
    noun: 'Ollama server',
    ...extra,
  };
}

const launch = vi.fn<(id: string, action: string) => Promise<ModelServerMutationResult>>();
const check = vi.fn(async () => []);
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const q = (testId: string, within: ParentNode = document) =>
  within.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

function show(node: ReactNode) {
  act(() => root?.render(<CssVarsProvider theme={desktopTheme}>{node}</CssVarsProvider>));
}

function render(view: ModelServerLaunchView | null, onStarted = vi.fn(), compact = false) {
  show(<OllamaNotRunning launch={view} onStarted={onStarted} compact={compact} />);
  return onStarted;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  launch.mockReset();
  check.mockClear();
  (window as unknown as { b4m: unknown }).b4m = { modelServers: { launch, check } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe('OllamaNotRunning', () => {
  it('offers Start when Desktop can start Ollama here', () => {
    render(launchView());
    expect(q('ollama-not-running')?.textContent).toContain(OLLAMA_NOT_RUNNING);
    expect(q('ollama-not-running')?.dataset.phase).toBe('idle');
    expect(q('ollama-start-btn')).not.toBeNull();
    expect(q('ollama-start-hint')).toBeNull();
  });

  it('shows how to start it by hand, and rechecks once, when Desktop cannot start it', () => {
    render(launchView({ canStart: false }));
    expect(q('ollama-start-btn')).toBeNull();
    expect(q('ollama-start-hint')?.textContent).toBe(OLLAMA_START_HINT);
    expect(check).toHaveBeenCalledWith('local');

    render(null);
    expect(q('ollama-start-btn')).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('rechecks on Check again and runs the caller retry', () => {
    const onRetry = vi.fn();
    show(<OllamaNotRunning launch={launchView({ canStart: false })} onStarted={vi.fn()} onRetry={onRetry} />);
    check.mockClear();
    act(() => q('ollama-recheck-btn')?.click());
    expect(check).toHaveBeenCalledWith('local');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps Start mounted, focused and aria-disabled while starting, and starts once however often it is clicked', async () => {
    const pending = deferred<ModelServerMutationResult>();
    launch.mockReturnValue(pending.promise);
    const onStarted = render(launchView());
    const button = q('ollama-start-btn');
    act(() => {
      button?.focus();
      button?.click();
    });
    act(() => button?.click());
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('local', 'start');
    expect(q('ollama-start-btn')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.querySelector('[aria-label="Starting Ollama"]')).not.toBeNull();
    expect(q('ollama-start-progress')?.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(onStarted).not.toHaveBeenCalled();

    pending.resolve({ ok: true, servers: [] });
    await flush();
    expect(q('ollama-start-done')).not.toBeNull();
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('starts once for two clicks in the same tick, before a render can mark the button', () => {
    launch.mockReturnValue(new Promise(() => {}));
    render(launchView());
    const button = q('ollama-start-btn');
    act(() => {
      button?.click();
      button?.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('shows a start running from elsewhere as progress', () => {
    render(launchView({ busy: 'starting', canStart: false }));
    expect(q('ollama-start-progress')).not.toBeNull();
    expect(q('ollama-start-btn')?.getAttribute('aria-disabled')).toBe('true');
    act(() => q('ollama-start-btn')?.click());
    expect(launch).not.toHaveBeenCalled();
  });

  it('shows the error of a failed start, never success, and offers Start again', async () => {
    launch.mockResolvedValue({ ok: false, error: 'Desktop could not find Ollama on this computer.' });
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await flush();
    const failed = q('ollama-start-error');
    expect(failed?.textContent).toBe('Ollama did not start: Desktop could not find Ollama on this computer.');
    expect(failed?.closest('[role="status"]')).not.toBeNull();
    expect(q('ollama-start-done')).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(q('ollama-start-btn')?.getAttribute('aria-disabled')).toBe('false');
  });

  it('fails a start that rejects', async () => {
    launch.mockRejectedValue(new Error('ipc closed'));
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await flush();
    expect(q('ollama-start-error')?.textContent).toContain('ipc closed');
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('gives up waiting after START_WAIT_MS, and still counts a start main finishes later', async () => {
    vi.useFakeTimers();
    const pending = deferred<ModelServerMutationResult>();
    launch.mockReturnValue(pending.promise);
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WAIT_MS);
    });
    expect(q('ollama-start-error')?.textContent).toBe(
      `Ollama did not start: no answer within ${START_WAIT_MS / 1000} seconds.`
    );
    expect(onStarted).not.toHaveBeenCalled();
    expect(q('ollama-start-btn')?.getAttribute('aria-disabled')).toBe('true');
    act(() => q('ollama-start-btn')?.click());
    expect(launch).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, servers: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(q('ollama-start-error')).toBeNull();
    expect(q('ollama-start-done')).not.toBeNull();
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('never shows success for a start that fails after the wait ran out', async () => {
    vi.useFakeTimers();
    const pending = deferred<ModelServerMutationResult>();
    launch.mockReturnValue(pending.promise);
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WAIT_MS);
    });
    pending.resolve({ ok: false, error: 'port 11434 is in use' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(q('ollama-start-done')).toBeNull();
    expect(q('ollama-start-error')).not.toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('clears the wait timer when the banner goes away mid-start', () => {
    vi.useFakeTimers();
    launch.mockReturnValue(new Promise(() => {}));
    render(launchView());
    act(() => q('ollama-start-btn')?.click());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers Start again a while after a start, should Ollama still look down', async () => {
    vi.useFakeTimers();
    launch.mockResolvedValue({ ok: true, servers: [] });
    render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(q('ollama-start-done')).not.toBeNull();
    expect(q('ollama-start-btn')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTED_SHOW_MS);
    });
    expect(q('ollama-start-done')).toBeNull();
    expect(q('ollama-start-btn')).not.toBeNull();
  });

  it('keeps an outcome to the banner that started it, with another banner on screen', async () => {
    launch.mockResolvedValue({ ok: false, error: 'port 11434 is in use' });
    const view = launchView();
    show(
      <>
        <div data-testid="first">
          <OllamaNotRunning launch={view} onStarted={vi.fn()} />
        </div>
        <div data-testid="second">
          <OllamaNotRunning launch={view} onStarted={vi.fn()} compact />
        </div>
      </>
    );
    const first = q('first') as HTMLElement;
    const second = q('second') as HTMLElement;
    act(() => q('ollama-start-btn', first)?.click());
    await flush();
    expect(q('ollama-start-error', first)).not.toBeNull();
    expect(q('ollama-start-error', second)).toBeNull();
    expect(q('ollama-start-btn', second)?.getAttribute('aria-disabled')).toBe('false');
  });

  it('drops a start that settles after the banner is gone', async () => {
    const pending = deferred<ModelServerMutationResult>();
    launch.mockReturnValue(pending.promise);
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    act(() => root?.unmount());
    root = null;
    pending.resolve({ ok: true, servers: [] });
    await flush();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('fits the composer in one row with the same title', () => {
    render(launchView(), vi.fn(), true);
    expect(q('ollama-not-running')?.textContent).toContain(OLLAMA_NOT_RUNNING);
    expect(q('ollama-start-btn')).not.toBeNull();
  });
});

describe('ComposerOllamaNotice', () => {
  it('drops a failed start on a switch to another conversation', async () => {
    launch.mockResolvedValue({ ok: false, error: 'port 11434 is in use' });
    const reload = vi.fn();
    show(<ComposerOllamaNotice sessionId="a" launch={launchView()} reload={reload} />);
    act(() => q('ollama-start-btn')?.click());
    await flush();
    expect(q('ollama-start-error')).not.toBeNull();

    show(<ComposerOllamaNotice sessionId="b" launch={launchView()} reload={reload} />);
    expect(q('ollama-start-error')).toBeNull();
    expect(q('ollama-start-btn')).not.toBeNull();
  });

  it('reloads the chat model list on Check again', () => {
    const reload = vi.fn();
    show(<ComposerOllamaNotice sessionId="a" launch={launchView({ canStart: false })} reload={reload} />);
    check.mockClear();
    act(() => q('ollama-recheck-btn')?.click());
    expect(check).toHaveBeenCalledWith('local');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
