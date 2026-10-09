import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { CookieImportState } from '@shared/browserCookies';
import type { BrowserGoAction, BrowserPaneBounds, BrowserPaneState } from '@shared/ipc';
import { BrowserNavbar } from './BrowserNavbar';
import { BROWSER_PANE_WIDTH, coveredByOverlay, overlayRects, sameBounds, toPaneBounds } from './agentBrowser';
import {
  BROWSER_PANE_MIN_WIDTH,
  browserPaneMaxWidth,
  clampBrowserPaneWidth,
  readBrowserPaneWidth,
  writeBrowserPaneWidth,
} from './browserPaneWidth';
import { ResizeHandle } from './ResizeHandle';

/** The element React renders the app into; everything else in the body is a portalled layer. */
const ROOT_ID = 'root';

/**
 * How many frames to keep re-measuring after something moved.
 *
 * A single measurement taken when a ResizeObserver fires is the position BEFORE any transition
 * finishes, and the pane would then sit a sidebar's width off for as long as nothing else
 * happened. Measuring for a few frames afterwards costs one rect read each and is what makes
 * collapsing the sidebar look like the web page moved with everything else.
 */
const SETTLE_FRAMES = 12;

/** Long enough for any layout transition in the app to have finished. See `settle` below. */
const SETTLE_MS = 400;

/** A conversation with no browser yet, and what the bar draws while one is being asked for. */
const NO_PAGE: BrowserPaneState = { url: '', canGoBack: false, canGoForward: false, loading: false, error: '' };

/** Before main has answered. Nothing imported, and the menu item disabled until it says otherwise. */
const NO_COOKIES: CookieImportState = { supported: false, unsupported: '', sites: [] };

/**
 * The agent's browser, as a pane on the right of the window.
 *
 * What this component draws is a navbar and a HOLE, not a web page: the page is a native view
 * the main process parents to the window and positions in front of the renderer, so nothing
 * here can contain it, style it or paint over it. This element's only jobs are to take up the
 * right amount of room, to tell main where that room ended up, and to say so when something has
 * to be drawn on top - see agentBrowser.ts for why that last one is not optional.
 *
 * The hole is the INNER element, below the navbar, and that is load-bearing rather than
 * cosmetic: the page covers every pixel of the rectangle reported from here, so a bar measured
 * as part of it would be a bar nobody can see or click.
 *
 * The empty state underneath is visible exactly when there is no page to cover it.
 *
 * Its left edge is a resize handle. The page is taken off the window for as long as a drag is
 * moving: once the pointer crossed into the native view this document would stop hearing about
 * it, and the drag would stick there. `conversation` is the column it trades width with, which
 * is what the drag's maximum is measured from.
 */
export function BrowserPane({
  sessionId,
  suspended,
  conversation,
}: {
  sessionId: string | null;
  suspended: boolean;
  conversation: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const [preferred, setPreferred] = useState(readBrowserPaneWidth);
  const [limit, setLimit] = useState(() => browserPaneMaxWidth(window.innerWidth, Number.POSITIVE_INFINITY));
  const [dragging, setDragging] = useState(false);
  // `resizing` is set on the first move rather than the press, so a click or the double-click
  // reset does not blink the page off and on.
  const live = useRef({ dragging: false, resizing: false, width: 0, frame: 0 });
  const width = clampBrowserPaneWidth(preferred, limit);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const settleRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<BrowserPaneState>(NO_PAGE);
  // Not per conversation: the jar is one for the whole window, so what is imported is imported
  // everywhere. The pane says as much; see CookieImporter for what scoping it would take.
  const [cookies, setCookies] = useState<CookieImportState>(NO_COOKIES);

  useEffect(() => {
    void window.b4m.browser.cookies.getState().then(setCookies);
    return window.b4m.browser.cookies.onChanged(setCookies);
  }, []);

  const report = useCallback(
    (bounds: BrowserPaneBounds | null) => {
      void window.b4m.browser.setPane({ sessionId, bounds }).then(setState);
    },
    [sessionId]
  );

  // A conversation switch must not leave the previous one's address in the bar for as long as
  // the first report of the new one is in flight.
  useEffect(() => setState(NO_PAGE), [sessionId]);

  /** A rejection from main - a scheme refused, a page already gone - is the bar's error to draw. */
  const drive = useCallback((work: Promise<BrowserPaneState>) => {
    void work
      .then(setState)
      .catch((err: unknown) =>
        setState(current => ({ ...current, loading: false, error: err instanceof Error ? err.message : String(err) }))
      );
  }, []);

  const navigate = useCallback(
    (url: string) => {
      if (sessionId) drive(window.b4m.browser.navigate({ sessionId, url }));
    },
    [sessionId, drive]
  );

  const go = useCallback(
    (action: BrowserGoAction) => {
      if (sessionId) drive(window.b4m.browser.go({ sessionId, action }));
    },
    [sessionId, drive]
  );

  /** Where the page may draw, or null for "not right now" - see agentBrowser.ts for the cases. */
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element || !sessionId) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const hidden = suspendedRef.current || live.current.resizing;
    if (hidden || coveredByOverlay(rect, overlayRects(Array.from(document.body.children), ROOT_ID))) {
      return null;
    }
    return toPaneBounds(rect);
  }, [sessionId]);

  useEffect(() => {
    let last: BrowserPaneBounds | null | undefined;
    let frames = 0;
    let pending = 0;
    let backstop: ReturnType<typeof setTimeout> | undefined;

    const push = () => {
      const bounds = measure();
      if (last !== undefined && sameBounds(bounds, last)) return;
      last = bounds;
      report(bounds);
    };

    const tick = () => {
      push();
      pending = frames-- > 0 ? requestAnimationFrame(tick) : 0;
    };
    const settle = () => {
      // Straight away, and only THEN over the next frames. Chromium throttles rAF in a window
      // it considers occluded, so a burst that only ran on frames would leave the page at its
      // old bounds for as long as the user had something else in front - and the mismatch
      // would be waiting for them when they came back.
      push();
      frames = SETTLE_FRAMES;
      if (!pending) pending = requestAnimationFrame(tick);
      // The backstop for the same case: an animated layout settles at a size no frame of the
      // burst saw, and nothing else is going to fire afterwards.
      clearTimeout(backstop);
      backstop = setTimeout(push, SETTLE_MS);
    };

    settleRef.current = settle;
    push();
    // The pane's own box covers a resize of the window's height and of the pane itself; the
    // document element covers a resize that moves the pane without changing its size, which is
    // every horizontal one, since the pane is pinned to the right edge.
    const resizes = new ResizeObserver(settle);
    if (ref.current) resizes.observe(ref.current);
    resizes.observe(document.documentElement);
    // Modals, menus and tooltips appear and disappear as children of the body.
    const overlays = new MutationObserver(settle);
    overlays.observe(document.body, { childList: true, subtree: false });
    window.addEventListener('resize', settle);

    const unsubscribe = window.b4m.browser.onPageState(event => {
      if (event.sessionId !== sessionId) return;
      const { sessionId: _ignored, ...next } = event;
      setState(next);
    });

    return () => {
      settleRef.current = null;
      resizes.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', settle);
      if (pending) cancelAnimationFrame(pending);
      clearTimeout(backstop);
      unsubscribe();
      // Whatever replaces this - another conversation, a closed pane, another screen - the page
      // must be off the window before it draws, or it is left floating over whatever is there.
      void window.b4m.browser.setPane({ sessionId: null, bounds: null });
    };
  }, [sessionId, measure, report]);

  // Read through a ref by `measure`, so standing down and coming back is one report each rather
  // than tearing the observers down - whose cleanup is a report of its own.
  useEffect(() => settleRef.current?.(), [suspended]);

  // The window, the sidebar and the task panel all move the maximum. The pane and the
  // conversation together are the width those leave over, however the two split it, so a drag
  // does not move it and the observer settles after one measurement.
  useLayoutEffect(() => {
    const measureLimit = () => {
      const other = conversation.current?.getBoundingClientRect().width;
      const own = pane.current?.getBoundingClientRect().width ?? 0;
      setLimit(browserPaneMaxWidth(window.innerWidth, other === undefined ? Number.POSITIVE_INFINITY : own + other));
    };
    measureLimit();
    const resizes = new ResizeObserver(measureLimit);
    if (conversation.current) resizes.observe(conversation.current);
    window.addEventListener('resize', measureLimit);
    return () => {
      resizes.disconnect();
      window.removeEventListener('resize', measureLimit);
    };
  }, [conversation]);

  useEffect(() => {
    const current = live.current;
    return () => cancelAnimationFrame(current.frame);
  }, []);

  // A drag writes the width straight to the element, once a frame, and commits state only on
  // release: a render per pointermove would re-lay the transcript beside it each time for nothing.
  const applyWidth = (next: number) => {
    if (pane.current) pane.current.style.width = `${next}px`;
  };

  const onWidth = useCallback((next: number) => {
    const current = live.current;
    current.width = next;
    if (current.dragging && !current.resizing) {
      // Straight away rather than from a render: the first width lands on a frame, which can come
      // before React would have rendered a stand-down, and the page would follow it once.
      current.resizing = true;
      settleRef.current?.();
    }
    if (!current.frame) {
      current.frame = requestAnimationFrame(() => {
        current.frame = 0;
        applyWidth(current.width);
      });
    }
  }, []);

  const onCommit = useCallback((next: number) => {
    cancelAnimationFrame(live.current.frame);
    live.current.frame = 0;
    live.current.resizing = false;
    applyWidth(next);
    // After the width, so coming back from a drag is the one report at the final size.
    settleRef.current?.();
    setPreferred(next);
    writeBrowserPaneWidth(next);
  }, []);

  const onDraggingChange = useCallback((next: boolean) => {
    live.current.dragging = next;
    setDragging(next);
  }, []);

  const clamp = useCallback((next: number) => clampBrowserPaneWidth(next, limit), [limit]);

  return (
    <Box
      ref={pane}
      style={{ width }}
      sx={{
        position: 'relative',
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
      }}
      data-testid="chat-browser-pane"
    >
      {/* Entirely left of the page: the native view covers every pixel of the hole, a handle
        reaching into it would be a handle nobody can find below the navbar. */}
      <ResizeHandle
        edge="left"
        label="Resize browser"
        testId="browser-resize-handle"
        width={width}
        min={Math.min(BROWSER_PANE_MIN_WIDTH, limit)}
        max={limit}
        defaultWidth={BROWSER_PANE_WIDTH}
        clamp={clamp}
        dragging={dragging}
        onWidth={onWidth}
        onCommit={onCommit}
        onDraggingChange={onDraggingChange}
        sx={{ left: -5 }}
      />
      <BrowserNavbar state={state} cookies={cookies} onNavigate={navigate} onGo={go} onCookieState={setCookies} />
      <Box ref={ref} sx={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center' }}>
        {!state.url && (
          <Stack spacing={0.5} alignItems="center" sx={{ px: 3, textAlign: 'center' }}>
            <Typography level="body-sm" textColor="text.tertiary" data-testid="chat-browser-pane-empty">
              This conversation&apos;s browser has not opened a page yet.
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              Type an address above, or ask the agent to open one.
            </Typography>
          </Stack>
        )}
      </Box>
    </Box>
  );
}
