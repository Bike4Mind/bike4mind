import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pages a sentinel may load in a row while it never leaves the viewport and the user does
 * nothing. A page whose rows land in folded or capped groups grows nothing on screen, so the
 * sentinel stays in view; past this many pages it stops and offers a button instead of walking
 * the whole list unasked. Any scroll input from the user re-arms it.
 */
export const MAX_AUTO_PAGES = 3;

/** Input on the scroller that means the user is moving through the list, not the list growing. */
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

/** How far below the viewport the next page starts loading, so the user rarely sees it arrive. */
const PREFETCH_MARGIN = '240px';

export interface LoadMoreSentinel {
  /** Attach to the sentinel element at the end of the list. */
  ref: (element: Element | null) => void;
  /** The sentinel stayed in view for MAX_AUTO_PAGES pages; the list should offer a button. */
  stalled: boolean;
}

/**
 * Infinite loading for a list whose end is marked by a sentinel element. Asks for the next page
 * only when the sentinel scrolls into view (or is still in view once a page lands, up to
 * MAX_AUTO_PAGES), never while a page is loading and never once `hasMore` is false - so it cannot
 * loop. The caller's `onLoadMore` must itself refuse a second request in flight.
 *
 * `root` is the scrolling element; null uses the viewport.
 */
export function useLoadMoreSentinel({
  hasMore,
  loading,
  onLoadMore,
  root,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  root: Element | null;
}): LoadMoreSentinel {
  const [element, setElement] = useState<Element | null>(null);
  const [stalled, setStalled] = useState(false);
  // Bumped to observe afresh, which re-reports a sentinel that never left view.
  const [armed, setArmed] = useState(0);
  const autoPages = useRef(0);
  const latest = useRef({ hasMore, loading, onLoadMore });
  latest.current = { hasMore, loading, onLoadMore };

  const onIntersect = useCallback((entries: IntersectionObserverEntry[]) => {
    const entry = entries.at(-1);
    if (!entry) return;
    if (!entry.isIntersecting) {
      // The rows pushed it out of view: the next sighting is the user scrolling, not a stall.
      autoPages.current = 0;
      setStalled(false);
      return;
    }
    const { hasMore: more, loading: busy, onLoadMore: load } = latest.current;
    if (!more || busy) return;
    if (autoPages.current >= MAX_AUTO_PAGES) {
      setStalled(true);
      return;
    }
    autoPages.current++;
    load();
  }, []);

  // Re-created when a page lands (loading goes false): observing afresh reports the sentinel's
  // current state once, which is what lets a still-visible sentinel ask for the next page.
  useEffect(() => {
    if (!element || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(onIntersect, { root, rootMargin: `0px 0px ${PREFETCH_MARGIN} 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, root, hasMore, loading, onIntersect, armed]);

  useEffect(() => {
    const target: EventTarget | null = root ?? element?.ownerDocument ?? null;
    if (!target) return;
    const userMoved = () => {
      if (autoPages.current === 0) return;
      autoPages.current = 0;
      setStalled(false);
      setArmed(count => count + 1);
    };
    for (const type of USER_SCROLL_EVENTS) target.addEventListener(type, userMoved, { passive: true });
    return () => {
      for (const type of USER_SCROLL_EVENTS) target.removeEventListener(type, userMoved);
    };
  }, [root, element]);

  useEffect(() => {
    if (hasMore) return;
    autoPages.current = 0;
    setStalled(false);
  }, [hasMore]);

  return { ref: setElement, stalled };
}
