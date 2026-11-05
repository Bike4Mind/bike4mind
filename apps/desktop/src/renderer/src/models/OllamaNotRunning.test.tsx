// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ModelServerLaunchView, ModelServerMutationResult } from '@shared/modelServers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { OLLAMA_NOT_RUNNING, OLLAMA_START_HINT } from './localRuntimeCopy';
import { OllamaNotRunning, START_WAIT_MS, STARTED_SHOW_MS } from './OllamaNotRunning';

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

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

function render(view: ModelServerLaunchView | null, onStarted = vi.fn(), compact = false) {
  act(() =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <OllamaNotRunning launch={view} onStarted={onStarted} compact={compact} />
      </CssVarsProvider>
    )
  );
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

  it('shows progress while starting and starts once however often Start is clicked', async () => {
    const pending = deferred<ModelServerMutationResult>();
    launch.mockReturnValue(pending.promise);
    const onStarted = render(launchView());
    const button = q('ollama-start-btn');
    act(() => {
      button?.click();
      button?.click();
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('local', 'start');
    expect(q('ollama-start-progress')).not.toBeNull();
    expect(q('ollama-start-btn')).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();

    pending.resolve({ ok: true, servers: [] });
    await flush();
    expect(q('ollama-start-done')).not.toBeNull();
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('shows a start running from elsewhere as progress, without a Start button', () => {
    render(launchView({ busy: 'starting', canStart: false }));
    expect(q('ollama-start-progress')).not.toBeNull();
    expect(q('ollama-start-btn')).toBeNull();
  });

  it('shows the error of a failed start, never success, and offers Start again', async () => {
    launch.mockResolvedValue({ ok: false, error: 'Desktop could not find Ollama on this computer.' });
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await flush();
    expect(q('ollama-start-error')?.textContent).toContain('Desktop could not find Ollama on this computer.');
    expect(q('ollama-start-done')).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    expect(q('ollama-start-btn')).not.toBeNull();
  });

  it('fails a start that rejects', async () => {
    launch.mockRejectedValue(new Error('ipc closed'));
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await flush();
    expect(q('ollama-start-error')?.textContent).toContain('ipc closed');
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('gives up waiting after START_WAIT_MS', async () => {
    vi.useFakeTimers();
    launch.mockReturnValue(new Promise(() => {}));
    const onStarted = render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_WAIT_MS);
    });
    expect(q('ollama-start-error')?.textContent).toContain(`${START_WAIT_MS / 1000} seconds`);
    expect(onStarted).not.toHaveBeenCalled();
    expect(q('ollama-start-btn')).not.toBeNull();
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTED_SHOW_MS);
    });
    expect(q('ollama-start-done')).toBeNull();
    expect(q('ollama-start-btn')).not.toBeNull();
  });

  it('keeps an outcome to the banner that started it', async () => {
    launch.mockResolvedValue({ ok: false, error: 'port 11434 is in use' });
    render(launchView());
    act(() => q('ollama-start-btn')?.click());
    await flush();
    expect(q('ollama-start-error')).not.toBeNull();

    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    render(launchView({ problem: 'port 11434 is in use' }));
    expect(q('ollama-start-error')).toBeNull();
    expect(q('ollama-start-btn')).not.toBeNull();
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

  it('fits the composer in one row with the same wording', () => {
    render(launchView(), vi.fn(), true);
    expect(q('ollama-not-running')?.textContent).toContain(`${OLLAMA_NOT_RUNNING}.`);
    expect(q('ollama-start-btn')).not.toBeNull();
  });
});
