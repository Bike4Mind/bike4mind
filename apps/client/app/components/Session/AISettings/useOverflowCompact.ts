import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Whether a horizontally scrolling row has run out of room, with hysteresis: it goes compact the
 * moment its full-size content overflows, and only comes back once the row is at least as wide as
 * that content measured - so the narrower compact content can never flip it straight back. Watches
 * the row and each child, so a child growing (more tool indicators, a longer model name) counts too.
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
    Array.from(row.children).forEach(child => observer.observe(child));
    const mutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observer.disconnect();
            observer.observe(row);
            Array.from(row.children).forEach(child => observer.observe(child));
            check();
          });
    mutations?.observe(row, { childList: true });
    return () => {
      mutations?.disconnect();
      observer.disconnect();
    };
  }, [rowRef, compact]);

  return compact;
}
