import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type VirtuosoHandle } from 'react-virtuoso';

const FIRST_ITEM_START = 100_000;

// Re-arm auto-follow only at the TRUE bottom (small epsilon absorbs sub-pixel
// rounding). A wide band is what trapped the user: a scroll-up during streaming
// necessarily starts at the bottom, so a wide re-arm threshold snaps the view
// back before the user can escape it.
const AT_BOTTOM_EPSILON_PX = 2;
// After a touch ends, keep auto-follow suppressed briefly. Inertial/momentum
// scrolling emits `scroll` events but no `touchmove`, so without this settle a
// flick that begins near the bottom would re-arm following mid-momentum and the
// per-frame pin would kill the inertia and snap back.
const TOUCH_SETTLE_MS = 400;

type ChatHistoryItem = { id?: string };

type UseVirtuosoPaginationParams = {
  sessionId: string;
  filteredChatHistory: ChatHistoryItem[];
  hasNextPage: boolean;
  fetchNextPage: () => void;
  /** True while a quest is active at the bottom - both the optimistic "preparing"
   *  window and live streaming. Drives the auto-scroll / follow behavior. */
  isActive: boolean;
};

type UseVirtuosoPaginationReturn = {
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  firstItemIndex: number;
  isAtBottom: boolean;
  setIsAtBottom: (value: boolean) => void;
  scrollerElementRef: RefObject<HTMLElement | null>;
  handleScrollerRef: (el: HTMLElement | Window | null) => void;
  handleStartReached: () => void;
};

export function useVirtuosoPagination({
  sessionId,
  filteredChatHistory,
  hasNextPage,
  fetchNextPage,
  isActive,
}: UseVirtuosoPaginationParams): UseVirtuosoPaginationReturn {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollerElementRef = useRef<HTMLElement | null>(null);

  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    scrollerElementRef.current = el instanceof HTMLElement ? el : null;
  }, []);

  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_START);
  const prevOldestIdRef = useRef<string | undefined>(undefined);
  const prevLengthRef = useRef(0);

  const handleStartReached = useCallback(() => {
    if (hasNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage]);

  // Reset firstItemIndex when session changes.
  // Declared BEFORE the prepend detection effect so that on initial mount,
  // the reset runs first and the prepend detection correctly sets prevLengthRef.
  useEffect(() => {
    setFirstItemIndex(FIRST_ITEM_START);
    prevLengthRef.current = 0;
    prevOldestIdRef.current = undefined;
  }, [sessionId]);

  // Only adjust firstItemIndex when OLDER items are prepended (pagination),
  // not when new messages are appended. Detect prepends by checking whether
  // the oldest item (last in filteredChatHistory, first after reversal) changed.
  useEffect(() => {
    const prevLength = prevLengthRef.current;
    const newLength = filteredChatHistory.length;
    const oldestId = filteredChatHistory[filteredChatHistory.length - 1]?.id;

    if (newLength > prevLength && prevLength > 0) {
      // Oldest item changed -> older page was loaded (prepend for Virtuoso).
      // Oldest item same -> new message arrived at the end (append) - no adjustment.
      if (oldestId !== prevOldestIdRef.current) {
        setFirstItemIndex(prev => prev - (newLength - prevLength));
      }
    }

    prevLengthRef.current = newLength;
    prevOldestIdRef.current = oldestId;
  }, [filteredChatHistory]);

  // Auto-scroll while a quest is active. We keep the viewport pinned to the ABSOLUTE
  // bottom - past the last message, into the Footer where the loading status (ReplyStatus)
  // and rapid replies live - so the just-submitted prompt AND its loading indicator stay
  // in view, whether the user was scrolled up or already at the bottom when they submitted.
  //
  // We re-pin EVERY frame (not just on scrollHeight changes) because the bottom content
  // reflows unpredictably while a quest spins up: the optimistic prompt bubble mounts, the
  // empty reply area sizes itself, the optimistic->streaming Footer swaps, and tokens resize
  // items. A one-shot scroll (or one that only reacts to height deltas) undershoots and
  // strands the view on the prompt with the Footer below the fold. Per-frame re-pinning also
  // lets Virtuoso render and measure the virtualized bottom region as we converge.
  //
  // Following stops only on a DELIBERATE user scroll-up (wheel up / touch drag down), never
  // on layout-induced scrollTop jitter. Inferring intent from scrollTop deltas was the bug:
  // reflow during spin-up clamps/nudges scrollTop and was misread as "user scrolled up",
  // which is exactly what left the loading message off-screen when submitting from the bottom.
  useEffect(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller || !isActive) return;

    let following = true;
    let rafId: number;
    // True from touchstart until a short settle after touchend, spanning the
    // momentum phase. While set, `scroll` events cannot re-arm following, so the
    // user's inertial scroll-up is never grabbed back by the per-frame pin.
    let userInteracting = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    // Wheel/touch are unambiguous user intent (unlike scrollTop, they're immune to the
    // layout jitter the per-frame pin causes), so ANY upward gesture detaches immediately
    // with no distance threshold - otherwise the per-frame pin re-grabs the view on the
    // next frame and fights the user, since a scroll-up begins while still at the bottom.
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) following = false;
    };

    let lastTouchY: number | null = null;
    const handleTouchStart = (e: TouchEvent) => {
      userInteracting = true;
      clearTimeout(settleTimer);
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null;
      // Finger moving DOWN reveals older content above = scrolling up.
      if (lastTouchY != null && y != null && y > lastTouchY) following = false;
      lastTouchY = y;
    };
    const handleTouchEnd = () => {
      lastTouchY = null;
      // Delay clearing so momentum scrolling stays covered. On expiry, re-arm
      // only if inertia actually settled at the true bottom.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        userInteracting = false;
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (distanceFromBottom <= AT_BOTTOM_EPSILON_PX) following = true;
      }, TOUCH_SETTLE_MS);
    };

    // Resume following once the viewport is back at the TRUE bottom (covers the
    // scroll-to-bottom button, scrollbar drag back down, and end-of-momentum).
    // Gated on !userInteracting so an in-progress touch/momentum scroll-up can't
    // re-arm it. Layout jitter never sets this to false, so it can only ever
    // re-enable following - safe to drive off scrollTop here.
    const handleScroll = () => {
      if (userInteracting) return;
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distanceFromBottom <= AT_BOTTOM_EPSILON_PX) following = true;
    };

    scroller.addEventListener('wheel', handleWheel, { passive: true });
    scroller.addEventListener('touchstart', handleTouchStart, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMove, { passive: true });
    scroller.addEventListener('touchend', handleTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    scroller.addEventListener('scroll', handleScroll, { passive: true });

    const loop = () => {
      if (following) {
        const target = scroller.scrollHeight - scroller.clientHeight;
        // Only scroll when not already at the bottom - a no-op read when stable.
        if (target - scroller.scrollTop > 1) {
          scroller.scrollTo({ top: scroller.scrollHeight });
        }
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(settleTimer);
      scroller.removeEventListener('wheel', handleWheel);
      scroller.removeEventListener('touchstart', handleTouchStart);
      scroller.removeEventListener('touchmove', handleTouchMove);
      scroller.removeEventListener('touchend', handleTouchEnd);
      scroller.removeEventListener('touchcancel', handleTouchEnd);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, [isActive]);

  return {
    virtuosoRef,
    firstItemIndex,
    isAtBottom,
    setIsAtBottom,
    scrollerElementRef,
    handleScrollerRef,
    handleStartReached,
  };
}
