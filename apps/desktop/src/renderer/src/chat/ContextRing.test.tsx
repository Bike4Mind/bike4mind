// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatPromptCacheStamp } from '@shared/chat';
import type { LoadedModelState } from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ContextRing } from './ContextRing';
import { LOADED_POLL_MS } from './contextStatus';

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

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const CLOUD = 'claude-opus-5-5';
const LOCAL = 'local:ollama:qwen3:8b';
const STAMP: ChatPromptCacheStamp = { cachedAt: NOW - 60_000, ttl: '5m', model: CLOUD };

let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: DocumentVisibilityState = 'visible';
const getLoadedState = vi.fn<(modelId: string) => Promise<LoadedModelState>>();

type Props = Parameters<typeof ContextRing>[0];
const BASE: Props = { tokens: 34_000, limit: 262_000, modelId: CLOUD, promptCache: STAMP, streaming: false };

function draw(props: Partial<Props> = {}) {
  act(() =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ContextRing {...BASE} {...props} />
      </CssVarsProvider>
    )
  );
}

function render(props: Partial<Props> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  draw(props);
}

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Lets a resolved IPC promise land. */
const settle = () => act(async () => {});

function hover() {
  act(() => {
    query('composer-context')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  act(() => vi.advanceTimersByTime(200));
}

const tooltip = () => query('composer-context-tooltip')?.textContent ?? null;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  getLoadedState.mockReset();
  getLoadedState.mockResolvedValue({ kind: 'loaded', expiresAt: NOW + 250_000 });
  (window as unknown as { b4m: { models: { getLoadedState: typeof getLoadedState } } }).b4m = {
    models: { getLoadedState },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe('ContextRing', () => {
  it('draws the context fill and names it for assistive tech', () => {
    render();
    const ring = query('composer-context-ring');
    expect(ring?.getAttribute('aria-label')).toBe('34k / 262k context (13%)');
    expect(ring?.getAttribute('aria-valuenow')).toBe('13');
  });

  it("counts a cloud reply's prompt cache down live while the tooltip is open", () => {
    render();
    hover();
    expect(tooltip()).toBe('34k / 262k context (13%)\nPrompt cache warm, expires in 3m 59s');
    act(() => vi.advanceTimersByTime(2000));
    expect(tooltip()).toBe('34k / 262k context (13%)\nPrompt cache warm, expires in 3m 57s');
    act(() => vi.advanceTimersByTime(240_000));
    expect(tooltip()).toBe('34k / 262k context (13%)\nPrompt cache expired');
    expect(getLoadedState).not.toHaveBeenCalled();
  });

  it('says nothing about a cache stamped for another model, or while a turn runs', () => {
    render({ promptCache: { ...STAMP, model: 'gpt-5' } });
    hover();
    expect(tooltip()).toBe('34k / 262k context (13%)');
    draw({ streaming: true });
    expect(tooltip()).toBe('34k / 262k context (13%)');
  });

  it('reports a local model as loaded with its keep-alive, read again on the poll and on hover', async () => {
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(1);
    expect(getLoadedState).toHaveBeenCalledWith(LOCAL);

    act(() => vi.advanceTimersByTime(LOADED_POLL_MS));
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);

    getLoadedState.mockResolvedValue({ kind: 'unloaded' });
    hover();
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(3);
    expect(tooltip()).toBe('34k / 262k context (13%)\nModel not loaded');
  });

  it('counts the keep-alive down while hovered', async () => {
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    hover();
    await settle();
    expect(tooltip()).toMatch(/Model loaded, unloads in 4m 9s$/);
    act(() => vi.advanceTimersByTime(3000));
    expect(tooltip()).toMatch(/Model loaded, unloads in 4m 6s$/);
  });

  it('stops polling on unmount, while a turn runs, and while the window is hidden', async () => {
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(1);

    draw({ modelId: LOCAL, promptCache: undefined, streaming: true });
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).toHaveBeenCalledTimes(1);

    draw({ modelId: LOCAL, promptCache: undefined, streaming: false });
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(3);

    act(() => root?.unmount());
    root = null;
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).toHaveBeenCalledTimes(3);
  });

  it('asks an OpenAI-compatible server once and then shows nothing for its cache', async () => {
    getLoadedState.mockResolvedValue({ kind: 'unsupported' });
    render({ modelId: 'local:srv-vllm:qwen', promptCache: undefined });
    await settle();
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).toHaveBeenCalledTimes(1);
    hover();
    expect(getLoadedState).toHaveBeenCalledTimes(1);
    expect(tooltip()).toBe('34k / 262k context (13%)');
  });

  it('never polls for a cloud model', () => {
    render({ promptCache: undefined });
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).not.toHaveBeenCalled();
  });
});
