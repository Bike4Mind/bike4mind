// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatPromptCacheStamp } from '@shared/chat';
import type { LoadedModelState } from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ContextRing } from './ContextRing';
import {
  LOADED_POLL_MS,
  cacheLine,
  coldAt,
  contextLine,
  contextRingValue,
  contextTooltip,
  isCacheCold,
  KEEP_ALIVE_FOREVER_MS,
  showColdDot,
  type CacheStatus,
} from './contextStatus';
import { REFRESH_AFTER_FAILURE_MS } from './useLoadedModelState';

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

// Joy's popups (menus, selects, tooltips, modals) read every ancestor's computed style on each update,
// and jsdom resolves that against every emotion sheet with no layout to find; the inline style will do.
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const CLOUD = 'claude-opus-5-5';
const LOCAL = 'local:ollama:qwen3:8b';
const STAMP: ChatPromptCacheStamp = { cachedAt: NOW - 60_000, ttl: '5m', model: CLOUD };

let root: Root | null = null;
let host: HTMLElement | null = null;
let visibility: DocumentVisibilityState = 'visible';
const getLoadedState = vi.fn<(modelId: string) => Promise<LoadedModelState>>();

type Props = Parameters<typeof ContextRing>[0];
const BASE: Props = {
  tokens: 34_000,
  limit: 262_000,
  modelId: CLOUD,
  promptCache: STAMP,
  streaming: false,
  hasReply: true,
};

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

function deferred() {
  let resolve: (state: LoadedModelState) => void = () => undefined;
  const promise = new Promise<LoadedModelState>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets a resolved IPC promise land. */
const settle = () => act(async () => {});

function hover() {
  act(() => {
    query('composer-context')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  act(() => vi.advanceTimersByTime(200));
}

function unhover() {
  act(() => {
    query('composer-context')?.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
    );
  });
  act(() => vi.advanceTimersByTime(1_000));
}

const COLD_LOCAL = '34k / 262k context (13%)\nModel not loaded: the next reply loads it first and re-reads 34k tokens';
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
    expect(tooltip()).toBe('34k / 262k context (13%)\nPrompt cache expired: the next message re-reads 34k tokens');
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
    expect(tooltip()).toBe(COLD_LOCAL);
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

  it('pauses polling after a failed read until the next hover or return to the window', async () => {
    getLoadedState.mockResolvedValue({ kind: 'unknown' });
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    expect(getLoadedState).toHaveBeenCalledTimes(1);

    hover();
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);
    expect(tooltip()).toBe('34k / 262k context (13%)');

    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(3);

    getLoadedState.mockResolvedValue({ kind: 'loaded', expiresAt: NOW + 250_000 });
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(4);
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS));
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(5);
  });

  it('does not re-ask on every hover while the last read failed', async () => {
    getLoadedState.mockResolvedValue({ kind: 'unknown' });
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(1);

    hover();
    await settle();
    unhover();
    hover();
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(1);

    unhover();
    act(() => vi.advanceTimersByTime(REFRESH_AFTER_FAILURE_MS));
    hover();
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);
  });

  it('treats a rejected read like a failed one', async () => {
    getLoadedState.mockResolvedValueOnce({ kind: 'loaded', expiresAt: NOW + 250_000 });
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    getLoadedState.mockRejectedValueOnce(new Error('ipc'));
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS));
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS * 3));
    await settle();
    expect(getLoadedState).toHaveBeenCalledTimes(2);
  });

  it('drops a response that arrives after a newer one', async () => {
    const first = deferred();
    const second = deferred();
    getLoadedState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render({ modelId: LOCAL, promptCache: undefined });
    hover();
    expect(getLoadedState).toHaveBeenCalledTimes(2);

    second.resolve({ kind: 'unloaded' });
    await settle();
    first.resolve({ kind: 'loaded', expiresAt: NOW + 250_000 });
    await settle();
    expect(tooltip()).toBe(COLD_LOCAL);
  });

  it('does not show the pre-turn state once a turn ends', async () => {
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    hover();
    await settle();
    expect(tooltip()).toMatch(/Model loaded, unloads in/);

    draw({ modelId: LOCAL, promptCache: undefined, streaming: true });
    const after = deferred();
    getLoadedState.mockReturnValueOnce(after.promise);
    draw({ modelId: LOCAL, promptCache: undefined, streaming: false });
    await settle();
    expect(tooltip()).toBe('34k / 262k context (13%)');

    after.resolve({ kind: 'unloaded' });
    await settle();
    expect(tooltip()).toBe(COLD_LOCAL);
  });

  it("never shows one local model's state for another", async () => {
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    hover();
    await settle();
    expect(tooltip()).toMatch(/Model loaded, unloads in/);

    const late = deferred();
    const other = deferred();
    getLoadedState.mockReturnValueOnce(late.promise);
    act(() => vi.advanceTimersByTime(LOADED_POLL_MS));
    expect(getLoadedState).toHaveBeenLastCalledWith(LOCAL);
    getLoadedState.mockReturnValueOnce(other.promise);
    draw({ modelId: 'local:ollama:llama3', promptCache: undefined });
    await settle();
    expect(getLoadedState).toHaveBeenLastCalledWith('local:ollama:llama3');
    expect(tooltip()).toBe('34k / 262k context (13%)');

    late.resolve({ kind: 'loaded', expiresAt: NOW + 250_000 });
    await settle();
    expect(tooltip()).toBe('34k / 262k context (13%)');
    other.resolve({ kind: 'unloaded' });
    await settle();
    expect(tooltip()).toBe(COLD_LOCAL);
  });

  it('shows no dot while a cloud cache is warm, and adds one when it expires with the tooltip closed', () => {
    render();
    expect(query('composer-context-cold')).toBeNull();
    act(() => vi.advanceTimersByTime(239_000));
    expect(query('composer-context-cold')).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(query('composer-context-cold')).not.toBeNull();
    expect(query('composer-context-ring')?.getAttribute('aria-label')).toBe(
      '34k / 262k context (13%). Prompt cache expired: the next message re-reads 34k tokens'
    );
  });

  it('re-arms when the timer fires before the clock reaches the expiry', () => {
    render();
    act(() => vi.advanceTimersByTime(239_999));
    const realNow = Date.now;
    // The timer fires 1ms early relative to Date.now.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 1);
    try {
      act(() => vi.advanceTimersByTime(1));
      expect(query('composer-context-cold')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(query('composer-context-cold')).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('shows the dot for an already expired cloud cache, but not mid-turn or without a prior reply', () => {
    render({ promptCache: { ...STAMP, cachedAt: NOW - 600_000 } });
    expect(query('composer-context-cold')).not.toBeNull();
    draw({ promptCache: { ...STAMP, cachedAt: NOW - 600_000 }, streaming: true });
    expect(query('composer-context-cold')).toBeNull();
    draw({ promptCache: { ...STAMP, cachedAt: NOW - 600_000 }, hasReply: false });
    expect(query('composer-context-cold')).toBeNull();
  });

  it('shows the dot for an unloaded local model, and not in a chat with no reply yet', async () => {
    getLoadedState.mockResolvedValue({ kind: 'unloaded' });
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    expect(query('composer-context-cold')).not.toBeNull();
    expect(query('composer-context-ring')?.getAttribute('aria-label')).toBe(
      '34k / 262k context (13%). Model not loaded: the next reply loads it first and re-reads 34k tokens'
    );
    draw({ modelId: LOCAL, promptCache: undefined, hasReply: false });
    expect(query('composer-context-cold')).toBeNull();
  });

  it('shows the dot when a loaded local model passes its keep-alive, with the tooltip closed', async () => {
    getLoadedState.mockResolvedValue({ kind: 'loaded', expiresAt: NOW + 5000 });
    render({ modelId: LOCAL, promptCache: undefined });
    await settle();
    expect(query('composer-context-cold')).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(query('composer-context-cold')).not.toBeNull();
  });

  it('falls back to a plain cold line when the context size is unknown', () => {
    render({ tokens: null, promptCache: { ...STAMP, cachedAt: NOW - 600_000 } });
    hover();
    expect(tooltip()).toBe('Context not measured yet\nPrompt cache expired');
  });
});

describe('contextRingValue', () => {
  it('fills by used over limit and colors by how close compaction is', () => {
    expect(contextRingValue(34_000, 262_000)).toEqual({ percent: 13, arc: 13, color: 'primary' });
    expect(contextRingValue(200_000, 250_000)).toMatchObject({ percent: 80, color: 'warning' });
    expect(contextRingValue(240_000, 250_000)).toMatchObject({ percent: 96, color: 'danger' });
  });

  it('keeps a sliver visible for a nearly empty context, and an empty ring when nothing is known', () => {
    expect(contextRingValue(100, 262_000)).toMatchObject({ percent: 0, arc: 4 });
    expect(contextRingValue(null, 262_000)).toEqual({ percent: null, arc: 0, color: 'neutral' });
    expect(contextRingValue(34_000, null)).toEqual({ percent: null, arc: 0, color: 'neutral' });
  });
});

describe('contextLine', () => {
  it('reads used / limit', () => {
    expect(contextLine(34_000, 262_000)).toBe('34k / 262k context (13%)');
    expect(contextLine(100, 262_000)).toBe('100 / 262k context (<1%)');
  });

  it('says what it knows when the limit or the count is missing', () => {
    expect(contextLine(34_000, null)).toBe('34k context used');
    expect(contextLine(null, 262_000)).toBe('Context not measured yet');
  });
});

describe('cacheLine', () => {
  it('counts a cloud prompt cache down, then calls it expired', () => {
    const status = { kind: 'cloud', expiresAt: NOW + 187_000 } as const;
    expect(cacheLine(status, NOW)).toBe('Prompt cache warm, expires in 3m 7s');
    expect(cacheLine(status, NOW + 180_000)).toBe('Prompt cache warm, expires in 7s');
    expect(cacheLine(status, NOW + 187_000)).toBe('Prompt cache expired');
  });

  it('says loaded rather than warm for a local model, with its keep-alive', () => {
    const loaded = (expiresAt: number | null) => ({ kind: 'local', state: { kind: 'loaded', expiresAt } }) as const;
    expect(cacheLine(loaded(NOW + 250_000), NOW)).toBe('Model loaded, unloads in 4m 10s');
    expect(cacheLine(loaded(null), NOW)).toBe('Model loaded');
    expect(cacheLine(loaded(NOW + KEEP_ALIVE_FOREVER_MS + 1), NOW)).toBe('Model loaded, no keep-alive limit');
    expect(cacheLine(loaded(NOW - 1), NOW)).toBe('Model not loaded');
    expect(cacheLine({ kind: 'local', state: { kind: 'unloaded' } }, NOW)).toBe('Model not loaded');
  });

  it('says nothing without a source', () => {
    expect(cacheLine(null, NOW)).toBeNull();
    expect(cacheLine({ kind: 'local', state: { kind: 'unsupported' } }, NOW)).toBeNull();
    expect(cacheLine({ kind: 'local', state: { kind: 'unknown' } }, NOW)).toBeNull();
  });
});

describe('contextTooltip', () => {
  it('puts the cache state on its own line, only when there is one', () => {
    expect(contextTooltip(34_000, 262_000, 'Model loaded')).toBe('34k / 262k context (13%)\nModel loaded');
    expect(contextTooltip(34_000, 262_000, null)).toBe('34k / 262k context (13%)');
  });
});

describe('cold cache', () => {
  const cloud = (expiresAt: number): CacheStatus => ({ kind: 'cloud', expiresAt });
  const loaded = (expiresAt: number | null): CacheStatus => ({ kind: 'local', state: { kind: 'loaded', expiresAt } });
  const unloaded: CacheStatus = { kind: 'local', state: { kind: 'unloaded' } };
  const idle = { streaming: false, hasReply: true };

  it('is cold for an expired cloud cache, an unloaded model, or a model past its keep-alive', () => {
    expect(isCacheCold(cloud(NOW), NOW)).toBe(true);
    expect(isCacheCold(unloaded, NOW)).toBe(true);
    expect(isCacheCold(loaded(NOW - 1), NOW)).toBe(true);
  });

  it('is not cold when warm or unknown', () => {
    expect(isCacheCold(cloud(NOW + 1), NOW)).toBe(false);
    expect(isCacheCold(loaded(NOW + 1000), NOW)).toBe(false);
    expect(isCacheCold(loaded(null), NOW)).toBe(false);
    expect(isCacheCold(loaded(NOW + KEEP_ALIVE_FOREVER_MS + 1), NOW)).toBe(false);
    expect(isCacheCold({ kind: 'local', state: { kind: 'unknown' } }, NOW)).toBe(false);
    expect(isCacheCold({ kind: 'local', state: { kind: 'unsupported' } }, NOW)).toBe(false);
    expect(isCacheCold(null, NOW)).toBe(false);
  });

  it('shows the dot only when idle and an earlier reply exists', () => {
    expect(showColdDot(cloud(NOW), NOW, idle)).toBe(true);
    expect(showColdDot(unloaded, NOW, idle)).toBe(true);
    expect(showColdDot(cloud(NOW), NOW, { ...idle, streaming: true })).toBe(false);
    expect(showColdDot(unloaded, NOW, { ...idle, hasReply: false })).toBe(false);
    expect(showColdDot(null, NOW, idle)).toBe(false);
  });

  it('finds the moment a warm status goes cold', () => {
    expect(coldAt(cloud(NOW + 5000), NOW)).toBe(NOW + 5000);
    expect(coldAt(loaded(NOW + 5000), NOW)).toBe(NOW + 5000);
    expect(coldAt(cloud(NOW), NOW)).toBeNull();
    expect(coldAt(loaded(null), NOW)).toBeNull();
    expect(coldAt(loaded(NOW + KEEP_ALIVE_FOREVER_MS + 1), NOW)).toBeNull();
    expect(coldAt(unloaded, NOW)).toBeNull();
  });

  it('says what the next message costs, falling back when tokens are unknown', () => {
    expect(cacheLine(cloud(NOW), NOW, 34_000)).toBe('Prompt cache expired: the next message re-reads 34k tokens');
    expect(cacheLine(cloud(NOW), NOW, null)).toBe('Prompt cache expired');
    expect(cacheLine(unloaded, NOW, 34_000)).toBe(
      'Model not loaded: the next reply loads it first and re-reads 34k tokens'
    );
    expect(cacheLine(loaded(NOW - 1), NOW, 900)).toBe(
      'Model not loaded: the next reply loads it first and re-reads 900 tokens'
    );
    expect(cacheLine(unloaded, NOW, null)).toBe('Model not loaded');
    expect(cacheLine(cloud(NOW + 5000), NOW, 34_000)).toBe('Prompt cache warm, expires in 5s');
  });
});
