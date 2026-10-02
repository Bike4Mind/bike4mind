import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { BrowserGoAction, BrowserPaneBounds, BrowserPaneState } from '@shared/ipc';
import { BrowserNavbar } from './BrowserNavbar';
import {
  BROWSER_PANE_MAX_FRACTION,
  BROWSER_PANE_WIDTH,
  coveredByOverlay,
  overlayRects,
  sameBounds,
  toPaneBounds,
} from './agentBrowser';

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
 */
export function BrowserPane({ sessionId, suspended }: { sessionId: string | null; suspended: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<BrowserPaneState>(NO_PAGE);

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
    if (suspended || coveredByOverlay(rect, overlayRects(Array.from(document.body.children), ROOT_ID))) return null;
    return toPaneBounds(rect);
  }, [sessionId, suspended]);

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

  return (
    <Box
      sx={{
        width: `min(${BROWSER_PANE_WIDTH}px, ${BROWSER_PANE_MAX_FRACTION})`,
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
      <BrowserNavbar state={state} onNavigate={navigate} onGo={go} />
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
