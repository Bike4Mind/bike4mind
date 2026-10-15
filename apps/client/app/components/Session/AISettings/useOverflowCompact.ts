import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Whether a horizontally scrolling row has run out of room, with hysteresis: it goes compact the
 * moment its full-size content overflows, and only comes back once the row is at least as wide as
 * that content measured - so the narrower compact content can never flip it straight back. Watches
 * the row and each child, so a child growing (more tool indicators, a longer model name) counts too,
 * as does one appearing (Research Mode turned on) in a row whose own size stays put.
 */
export function useOverflowCompact(rowRef: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  // The full-size content width last seen overflowing; what the row must reach to expand again.
  const neededWidth = useRef(0);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const check = () => {
      setCompact(wasCompact => {
        if (!wasCompact) {
          if (row.scrollWidth > row.clientWidth + 1) {
            neededWidth.current = row.scrollWidth;
            return true;
          }
          return false;
        }
        return row.clientWidth < neededWidth.current;
      });
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    const observeChildren = () => Array.from(row.children).forEach(child => observer.observe(child));
    observeChildren();
    const mutations = new MutationObserver(() => {
      observeChildren();
      check();
    });
    mutations.observe(row, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [rowRef, compact]);

  return compact;
}
