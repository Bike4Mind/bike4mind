// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUTO_PAGES, useLoadMoreSentinel, type LoadMoreSentinel } from './useLoadMoreSentinel';

/** IntersectionObserver double: reports the sentinel's visibility on observe, like the real one. */
class FakeObserver {
  static visible = false;
  static live = new Set<FakeObserver>();
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    FakeObserver.live.add(this);
    this.report();
  }
  disconnect() {
    FakeObserver.live.delete(this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  report() {
    this.callback([{ isIntersecting: FakeObserver.visible } as IntersectionObserverEntry], this as never);
  }
  static setVisible(visible: boolean) {
    FakeObserver.visible = visible;
    for (const observer of FakeObserver.live) observer.report();
  }
}

let root: Root | null = null;

beforeEach(() => {
  FakeObserver.visible = false;
  FakeObserver.live.clear();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

/**
 * Mounts the hook over a list whose `onLoadMore` flips `loading` until `finish` is called, the
 * way useSessions does, with the sentinel attached to a real element.
 */
async function mount(initial: { hasMore: boolean }) {
  const onLoadMore = vi.fn();
  let state = { hasMore: initial.hasMore, loading: false };
  let latest: LoadMoreSentinel | undefined;
  function Harness() {
    latest = useLoadMoreSentinel({
      hasMore: state.hasMore,
      loading: state.loading,
      onLoadMore: () => {
        onLoadMore();
        state = { ...state, loading: true };
        rerender();
      },
      root: null,
    });
    return <div ref={latest.ref} />;
  }
  const rerender = () => root?.render(<Harness />);
  root = createRoot(document.createElement('div'));
  await act(async () => rerender());
  return {
    onLoadMore,
    sentinel: () => latest as LoadMoreSentinel,
    finish: async (hasMore: boolean) => {
      state = { hasMore, loading: false };
      await act(async () => rerender());
    },
  };
}

describe('useLoadMoreSentinel', () => {
  it('loads only when the sentinel comes into view', async () => {
    const list = await mount({ hasMore: true });
    expect(list.onLoadMore).not.toHaveBeenCalled();
    act(() => FakeObserver.setVisible(true));
    expect(list.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('never asks again while a page is loading', async () => {
    const list = await mount({ hasMore: true });
    act(() => FakeObserver.setVisible(true));
    act(() => FakeObserver.setVisible(false));
    act(() => FakeObserver.setVisible(true));
    expect(list.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('never asks once there is nothing more', async () => {
    const list = await mount({ hasMore: true });
    act(() => FakeObserver.setVisible(true));
    await list.finish(false);
    act(() => FakeObserver.setVisible(false));
    act(() => FakeObserver.setVisible(true));
    expect(list.onLoadMore).toHaveBeenCalledTimes(1);
    expect(FakeObserver.live.size).toBe(0);
  });

  it('follows on while the sentinel stays in view, then stops and reports a stall', async () => {
    const list = await mount({ hasMore: true });
    act(() => FakeObserver.setVisible(true));
    for (let page = 1; page < MAX_AUTO_PAGES + 3; page++) await list.finish(true);
    expect(list.onLoadMore).toHaveBeenCalledTimes(MAX_AUTO_PAGES);
    expect(list.sentinel().stalled).toBe(true);
  });

  it('starts counting again once the rows push the sentinel out of view', async () => {
    const list = await mount({ hasMore: true });
    act(() => FakeObserver.setVisible(true));
    for (let page = 1; page < MAX_AUTO_PAGES; page++) await list.finish(true);
    await list.finish(true);
    expect(list.sentinel().stalled).toBe(true);
    act(() => FakeObserver.setVisible(false));
    expect(list.sentinel().stalled).toBe(false);
    act(() => FakeObserver.setVisible(true));
    expect(list.onLoadMore).toHaveBeenCalledTimes(MAX_AUTO_PAGES + 1);
  });

  it('re-arms on user scroll input, so scrolling on at the bottom keeps loading', async () => {
    const list = await mount({ hasMore: true });
    act(() => FakeObserver.setVisible(true));
    for (let page = 1; page <= MAX_AUTO_PAGES; page++) await list.finish(true);
    expect(list.sentinel().stalled).toBe(true);
    await act(async () => document.dispatchEvent(new Event('wheel')));
    expect(list.sentinel().stalled).toBe(false);
    expect(list.onLoadMore).toHaveBeenCalledTimes(MAX_AUTO_PAGES + 1);
  });
});
