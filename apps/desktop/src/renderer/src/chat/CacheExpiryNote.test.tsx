// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelOption, ChatPromptCacheStamp } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { CacheExpiryNote } from './CacheExpiryNote';
import { PromptCacheTtlPicker } from './PromptCacheTtlPicker';
import { modelSwitchCredits } from './modelSwitchCost';

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

const PER_MTOK = 1 / 1_000_000;
const OPUS: ChatModelOption = {
  id: 'claude-opus-5-5',
  name: 'Opus 5.5',
  backend: 'anthropic',
  supportsOneHourCache: true,
  pricing: { 200_000: { input: 5 * PER_MTOK, output: 25 * PER_MTOK, cache_write: 6.25 * PER_MTOK } },
};
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const STAMP: ChatPromptCacheStamp = { cachedAt: NOW, ttl: '5m', model: OPUS.id };

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<CssVarsProvider theme={desktopTheme}>{node}</CssVarsProvider>));
}

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('CacheExpiryNote', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 60_000);
  });
  afterEach(() => vi.useRealTimers());

  const note = (overrides: Partial<React.ComponentProps<typeof CacheExpiryNote>> = {}) => (
    <CacheExpiryNote stamp={STAMP} model={OPUS} contextTokens={150_000} ttl="5m" turnOpen={false} {...overrides} />
  );

  it('appears when the 5-minute cache runs out, with the re-write price', () => {
    render(note());
    expect(query('chat-cache-expiry-note')).toBeNull();

    act(() => vi.advanceTimersByTime(4 * 60_000));
    expect(query('chat-cache-expiry-note-text')?.textContent).toMatch(
      /^This chat's cache has expired: about [\d,]+ credits for the next message\.$/
    );
  });

  it('stays hidden while a turn runs, below the threshold, and after a dismissal', () => {
    vi.setSystemTime(NOW + 10 * 60_000);
    render(note({ turnOpen: true }));
    expect(query('chat-cache-expiry-note')).toBeNull();
    act(() => root?.unmount());

    render(note({ contextTokens: 1_000 }));
    expect(query('chat-cache-expiry-note')).toBeNull();
    act(() => root?.unmount());

    render(note());
    act(() => query('chat-cache-expiry-note-dismiss')?.click());
    expect(query('chat-cache-expiry-note')).toBeNull();
  });

  it('waits the full hour for a 1-hour cache', () => {
    render(note({ stamp: { ...STAMP, ttl: '1h' } }));
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(query('chat-cache-expiry-note')).toBeNull();
    act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(query('chat-cache-expiry-note')).not.toBeNull();
  });
});

describe('PromptCacheTtlPicker', () => {
  it('offers both lifetimes with their prices and reports the pick', () => {
    const onSelect = vi.fn();
    render(<PromptCacheTtlPicker model={OPUS} ttl="5m" contextTokens={150_000} onSelect={onSelect} />);
    expect(query('prompt-cache-ttl-picker-btn')?.textContent).toBe('Cache: 5m');

    act(() => query('prompt-cache-ttl-picker-btn')?.click());
    const credits = (ttl: '5m' | '1h') =>
      new Intl.NumberFormat('en-US').format(modelSwitchCredits(OPUS, 150_000, ttl)!);
    expect(query('prompt-cache-ttl-picker-option-5m-price')?.textContent).toContain(credits('5m'));
    expect(query('prompt-cache-ttl-picker-option-1h-price')?.textContent).toContain(credits('1h'));

    act(() => query('prompt-cache-ttl-picker-option-1h')?.click());
    expect(onSelect).toHaveBeenCalledWith('1h');
  });

  it('renders nothing for a model without the hour', () => {
    render(
      <PromptCacheTtlPicker
        model={{ ...OPUS, supportsOneHourCache: undefined }}
        ttl="5m"
        contextTokens={150_000}
        onSelect={vi.fn()}
      />
    );
    expect(query('prompt-cache-ttl-picker-btn')).toBeNull();
  });
});
