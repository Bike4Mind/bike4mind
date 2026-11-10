import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Box, Button, IconButton, Sheet, Stack, Typography } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseIcon from '@mui/icons-material/Close';
import type { TutorialCardSide } from '@bike4mind/common';
import { a11y, a11yAttr } from './a11y';

const CARD_WIDTH = 340;
const PANEL_WIDTH = 960;
const EDGE = 16;
const DOCK = EDGE * 1.5;
const GAP = 12;
const RING_PAD = 6;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// How long after a step starts the card keeps re-revealing an anchor the page moves out of view (a reply
// laid out late, a list re-measuring), and how still the layout must be before it looks again.
const SETTLE_MS = 2000;
const QUIET_MS = 150;
// Any of these means the user took over the page, so the card stops pulling the anchor back.
const USER_INPUT = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
// Above the host's side drawer and any modal, since an anchor such as a nav item or a solver panel's race
// button sits in one and the card has to stay pressable over its backdrop.
const LAYER = 'calc(var(--joy-zIndex-modal, 1300) + 1)';
/** One layer above the card, for anything that has to open over it. */
export const ABOVE_COACH_CARD = 'calc(var(--joy-zIndex-modal, 1300) + 2)';
const PULSE = (alpha: number) => `rgba(var(--joy-palette-primary-mainChannel) / ${alpha})`;
// A ripple out from the ring, so the step's target is findable at a glance (a file button, a sidebar entry).
const ringPulse = keyframes`
  0% { box-shadow: 0 0 0 0 ${PULSE(0.55)}; }
  70% { box-shadow: 0 0 0 10px ${PULSE(0)}; }
  100% { box-shadow: 0 0 0 0 ${PULSE(0)}; }
`;

/** Toasts the host raises. One lands over the composer's controls just as a step points at Send. */
export const TOAST_SELECTOR = '[data-sonner-toast]';

/**
 * What the step pill keeps clear of on every step, beside what the step avoids: the composer's voice button
 * sits in the corner the pill docks in, and a step pointing at the canvas has no reason to name it.
 */
export const PILL_AVOID_SELECTOR = `${TOAST_SELECTOR}, [data-testid="voice-record-btn"]`;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const toRect = ({ left, top, right, bottom }: Rect): Rect => ({ left, top, right, bottom });
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
const sameRects = (a: readonly Rect[], b: readonly Rect[]) =>
  a.length === b.length && a.every((rect, i) => sameRect(rect, b[i]));

const HIDDEN_ATTR = a11yAttr('ariaHidden');
const COVERED_SELECTOR = `[${HIDDEN_ATTR}="true"], [inert]`;

const findAnchor = (anchor: string, scope?: string) =>
  document.querySelector<HTMLElement>(`${scope ? `${scope} ` : ''}[data-testid="${CSS.escape(anchor)}"]`);

/** Whether any of the element falls outside the window or outside a scrolling box it sits in, such as the chat. */
function outOfView(element: HTMLElement): boolean {
  const { top, bottom } = element.getBoundingClientRect();
  if (top < 0 || bottom > window.innerHeight) return true;
  for (let box = element.parentElement; box; box = box.parentElement) {
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(box).overflowY)) continue;
    const clip = box.getBoundingClientRect();
    if (top < clip.top || bottom > clip.bottom) return true;
  }
  return false;
}

/** The anchor element, its viewport rect, and the rect of its scope (the canvas node it sits in, say). */
function useAnchorRect(anchor: string | undefined, scope: string | undefined, stepKey: string) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [scopeRect, setScopeRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!anchor) {
      setElement(null);
      return;
    }
    const isCurrent = (el: HTMLElement | null) =>
      !!el?.isConnected && el.getAttribute('data-testid') === anchor && (!scope || !!el.closest(scope));
    const sync = () => setElement(current => (isCurrent(current) ? current : findAnchor(anchor, scope)));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor, scope]);

  useEffect(() => {
    if (!element) {
      setRect(null);
      setScopeRect(null);
      return;
    }
    const container = scope ? element.closest<HTMLElement>(scope) : null;
    const measure = () => {
      // The ring draws above every modal, so an anchor a modal has covered (and hidden from assistive tech)
      // would get a ring floating over the modal's own content.
      const covered = !!element.closest(COVERED_SELECTOR);
      const next = covered ? null : toRect(element.getBoundingClientRect());
      const nextScope = container && !covered ? toRect(container.getBoundingClientRect()) : null;
      setRect(current => (sameRect(current, next) ? current : next));
      setScopeRect(current => (sameRect(current, nextScope) ? current : nextScope));
    };
    const reveal = () => {
      if (outOfView(element) && !element.closest(COVERED_SELECTOR))
        element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    };
    // The page can still be laying out when the anchor first appears, so look again once it goes quiet. Each
    // scroll, including the card's own, restarts the wait, so a reveal never interrupts one in flight.
    const settleUntil = Date.now() + SETTLE_MS;
    let settling = true;
    let quiet = 0;
    const stopSettling = () => {
      settling = false;
      clearTimeout(quiet);
    };
    const settle = () => {
      if (!settling) return;
      // Past the window, arm nothing new but let a reveal already waiting run.
      if (Date.now() > settleUntil) {
        settling = false;
        return;
      }
      clearTimeout(quiet);
      quiet = window.setTimeout(reveal, QUIET_MS);
    };
    const onLayout = () => {
      measure();
      settle();
    };
    reveal();
    measure();
    for (const type of USER_INPUT) window.addEventListener(type, stopSettling, { capture: true, passive: true });
    const resize = new ResizeObserver(onLayout);
    resize.observe(element);
    if (container) resize.observe(container);
    window.addEventListener('resize', onLayout);
    window.addEventListener('scroll', onLayout, true);
    // A layout shift elsewhere moves the anchor without resizing it, and a modal opening covers it.
    let pending = 0;
    const schedule = () => {
      if (!pending)
        pending = requestAnimationFrame(() => {
          pending = 0;
          onLayout();
        });
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [HIDDEN_ATTR, 'inert', 'style', 'class', 'hidden'],
    });
    // A canvas pans and zooms by CSS transform, which fires no resize or scroll, so follow the anchor per frame.
    let frame = 0;
    if (element.closest('.react-flow')) {
      const follow = () => {
        measure();
        frame = requestAnimationFrame(follow);
      };
      frame = requestAnimationFrame(follow);
    }
    return () => {
      stopSettling();
      for (const type of USER_INPUT) window.removeEventListener(type, stopSettling, { capture: true });
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pending);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', onLayout);
      window.removeEventListener('scroll', onLayout, true);
    };
  }, [element, scope, stepKey]);

  return { element, rect, scopeRect };
}

/** The rects of what `selector` matches, kept current as those elements come, go, move and resize. */
function useRects(selector: string | undefined) {
  const [rects, setRects] = useState<readonly Rect[]>([]);
  useEffect(() => {
    if (!selector) {
      setRects([]);
      return;
    }
    let frame = 0;
    const resize = new ResizeObserver(() => measure());
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
        elements.forEach(el => resize.observe(el));
        const next = elements
          .map(el => toRect(el.getBoundingClientRect()))
          .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
        setRects(current => (sameRects(current, next) ? current : next));
      });
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    // A toast slides in and out, so its resting place is known only once its transition ends.
    document.addEventListener('transitionend', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener('transitionend', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [selector]);
  return rects;
}

const readViewport = () => ({ width: window.innerWidth, height: window.innerHeight });

function useViewport() {
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const resize = () =>
      setViewport(current => {
        const next = readViewport();
        return current.width === next.width && current.height === next.height ? current : next;
      });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return viewport;
}

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: CARD_WIDTH, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize(current => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, [ref]);
  return size;
}

// An anchor scrolled or panned out of view, as on a canvas that does not scroll, would carry the card with it.
const onScreen = (rect: Rect) =>
  rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const pad = (rect: Rect, by: number): Rect => ({
  left: rect.left - by,
  top: rect.top - by,
  right: rect.right + by,
  bottom: rect.bottom + by,
});
const union = (a: Rect, b: Rect | null): Rect =>
  b
    ? {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
      }
    : a;

export interface PlaceCardInput {
  /** What the card must not cover: the ringed anchor, and the scope it sits in. */
  target: Rect;
  /** What it should rather not cover, such as a toast. */
  obstacles: readonly Rect[];
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  prefer?: TutorialCardSide;
}

/**
 * Where the card goes beside its target. Sides are tried in turn: the step's preferred one, the roomier of
 * below and above, then right and left. A side is taken when the card fits on screen there and covers neither
 * the target nor an obstacle, after sliding past any obstacle in its way. When no side is clear, the card
 * covers as little of the target, then of the obstacles, as it can.
 */
export function placeCard({ target, obstacles, card, viewport, prefer }: PlaceCardInput) {
  const { width: w, height: h } = card;
  const maxLeft = Math.max(EDGE, viewport.width - w - EDGE);
  const maxTop = Math.max(EDGE, viewport.height - h - EDGE);
  const roomBelow = viewport.height - target.bottom >= target.top;
  const order = [prefer, roomBelow ? 'below' : 'above', roomBelow ? 'above' : 'below', 'right', 'left'].filter(
    (side, i, all): side is TutorialCardSide => !!side && all.indexOf(side) === i
  );

  const at = (left: number, top: number): Rect => ({ left, top, right: left + w, bottom: top + h });
  const start = (side: TutorialCardSide): Rect => {
    const alongX = clamp(target.left, EDGE, maxLeft);
    const alongY = clamp(target.top, EDGE, maxTop);
    if (side === 'below') return at(alongX, target.bottom + GAP);
    if (side === 'above') return at(alongX, target.top - GAP - h);
    if (side === 'right') return at(target.right + GAP, alongY);
    return at(target.left - GAP - w, alongY);
  };
  const slidePast = (side: TutorialCardSide, rect: Rect, past: Rect): Rect => {
    if (side === 'below') return at(rect.left, past.bottom + GAP);
    if (side === 'above') return at(rect.left, past.top - GAP - h);
    if (side === 'right') return at(past.right + GAP, rect.top);
    return at(past.left - GAP - w, rect.top);
  };
  const fits = (rect: Rect) => rect.left >= EDGE && rect.top >= EDGE && rect.left <= maxLeft && rect.top <= maxTop;
  const covered = (rect: Rect) => obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0);

  const candidates = order.map(side => {
    let rect = start(side);
    for (let i = 0; i < obstacles.length; i++) {
      const hit = obstacles.find(obstacle => overlap(rect, obstacle) > 0);
      if (!hit) break;
      rect = slidePast(side, rect, hit);
    }
    return { side, rect };
  });
  const clear = candidates.find(({ rect }) => fits(rect) && overlap(rect, target) === 0 && covered(rect) === 0);
  if (clear) return { side: clear.side, left: clear.rect.left, top: clear.rect.top };

  const best = candidates
    .map(({ side, rect }) => {
      const shown = at(clamp(rect.left, EDGE, maxLeft), clamp(rect.top, EDGE, maxTop));
      return { side, rect: shown, onTarget: overlap(shown, target), onObstacles: covered(shown) };
    })
    .reduce((a, b) =>
      b.onTarget < a.onTarget || (b.onTarget === a.onTarget && b.onObstacles < a.onObstacles) ? b : a
    );
  return { side: best.side, left: best.rect.left, top: best.rect.top };
}

export interface DockCardInput {
  side: 'left' | 'right';
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  obstacles: readonly Rect[];
}

/**
 * How far above the window's bottom edge a card with no anchor docks: in its corner, or just above whatever
 * there it would cover, as long as it stays on screen.
 */
export function dockCard({ side, card, viewport, obstacles }: DockCardInput): number {
  const { width: w, height: h } = card;
  const left = side === 'left' ? DOCK : viewport.width - DOCK - w;
  let bottom = DOCK;
  for (let i = 0; i < obstacles.length; i++) {
    const top = viewport.height - bottom - h;
    const hit = obstacles.find(obstacle => overlap({ left, top, right: left + w, bottom: top + h }, obstacle) > 0);
    if (!hit) break;
    bottom = viewport.height - hit.top + GAP;
  }
  return Math.min(bottom, Math.max(DOCK, viewport.height - h - EDGE));
}

interface StepPillProps {
  label: string | undefined;
  side: 'left' | 'right';
  viewport: { width: number; height: number };
  avoided: readonly Rect[];
  onShow: () => void;
}

/** What a hidden card leaves behind: its step count, docked clear of what the step avoids. Pressing it reopens the card. */
function StepPill({ label, side, viewport, avoided, onShow }: StepPillProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const size = useSize(ref);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Button
      ref={ref}
      size="sm"
      variant="solid"
      color="primary"
      onClick={onShow}
      {...a11y({ ariaLabel: `Show tutorial card${label ? `, ${label}` : ''}` })}
      data-testid="tutorial-coach-pill"
      sx={{
        position: 'fixed',
        [side]: DOCK,
        bottom: dockCard({ side, card: size, viewport, obstacles: avoided }),
        borderRadius: 'xl',
        boxShadow: 'md',
        zIndex: LAYER,
      }}
    >
      {label ?? 'Tutorial'}
    </Button>
  );
}

export interface CoachMarkProps {
  /** Changes per step, so focus moves to the new step's button. */
  stepKey: string;
  body: string;
  title?: string;
  anchor?: string;
  anchorScope?: string;
  /** The side of the anchor to try first. With no anchor on screen, `left` docks the card bottom-left. */
  placement?: TutorialCardSide;
  /** A CSS selector for what the card keeps clear of, beside its anchor or, with none, where it docks. */
  avoid?: string;
  /** Card width in px; the default suits a short body. */
  width?: number;
  /** Opens the card over the middle of the page, on a scrim, in place of beside an anchor. */
  panel?: boolean;
  /** The step reports its action done; a card hidden to its pill comes back to say what is next. */
  done?: boolean;
  onLeave: () => void;
  onShowSteps?: () => void;
  /** Where this step sits in its module, shown as "Step 2 of 15". */
  progress?: { index: number; count: number };
  /** Shown in place of the step count on a card that has none. */
  heading?: string;
  children?: ReactNode;
}

/**
 * The tutorial's card, pointing at the step's anchor with a ring around it. Deliberately non-modal: the
 * page stays usable underneath, so the user can look around or leave by sending a message themselves.
 * Close and Escape only tuck the card into a pill for this step, to read what it covers; leaving is its own
 * labelled action. The card stays mounted while hidden, so the step keeps hearing the events it waits on.
 * A panel card is the exception: it closes the module, so it sits on a scrim and is modal, and its close
 * and Escape leave rather than hide.
 */
export function CoachMark({
  stepKey,
  body,
  title,
  anchor,
  anchorScope,
  placement,
  avoid,
  width: cardWidth = CARD_WIDTH,
  panel = false,
  done = false,
  onLeave,
  onShowSteps,
  progress,
  heading,
  children,
}: CoachMarkProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const { element, rect: anchorRect, scopeRect } = useAnchorRect(panel ? undefined : anchor, anchorScope, stepKey);
  const rect = anchorRect && onScreen(anchorRect) ? anchorRect : null;
  const avoided = useRects(avoid);
  const card = useSize(cardRef);
  const viewport = useViewport();
  const anchorRef = useRef<HTMLElement | null>(null);
  // eslint-disable-next-line react-hooks/refs -- effects and handlers read the latest anchor without re-subscribing
  anchorRef.current = element;
  const [hidden, setHidden] = useState(false);
  // Keyed by step and anchor, so a step that moves its anchor mid-step pulses the new target too.
  const pulseKey = `${stepKey}|${anchorScope ?? ''}|${anchor ?? ''}`;
  const [pressedFor, setPressedFor] = useState<string | null>(null);
  const pressed = pressedFor === pulseKey;
  // Reset during render, not in an effect, so a new or revisited step never paints a frame as a pill. A step
  // turning done resets it too: its doneBody, or the Next it now offers, is in the card, and the pill says nothing.
  const hiddenKey = done ? `${stepKey}:done` : stepKey;
  const [hiddenStep, setHiddenStep] = useState(hiddenKey);
  if (hiddenStep !== hiddenKey) {
    setHiddenStep(hiddenKey);
    setHidden(false);
  }
  const toasts = useRects(rect ? TOAST_SELECTOR : undefined);
  // Measured before the card hides, so the pill's first frame already sits clear of them.
  const pillAvoided = useRects(panel ? undefined : PILL_AVOID_SELECTOR);

  useEffect(() => {
    // A step that waits on the page has no button of its own; focus stays where the user is working.
    // A panel is modal, so focus has to enter it even when it offers no primary button. preventScroll
    // keeps a long panel opening at its top rather than at a button low down in it.
    const primary = cardRef.current?.querySelector<HTMLElement>('[data-tutorial-primary]');
    const target = primary ?? (panel ? cardRef.current : null);
    target?.focus({ preventScroll: panel });
  }, [stepKey, panel]);

  // The ring pulses until the user presses its target; `click` also covers a keyboard press.
  useEffect(() => {
    if (!element) return;
    const press = () => setPressedFor(pulseKey);
    element.addEventListener('click', press, true);
    return () => element.removeEventListener('click', press, true);
  }, [element, pulseKey]);

  // An anchor that is only a wrapper (the shelf's verb + chevron pair) hands focus to the control inside it.
  useEffect(
    () => () => {
      const anchorElement = anchorRef.current;
      const focusable =
        anchorElement && anchorElement.tabIndex < 0
          ? anchorElement.querySelector<HTMLElement>('[tabindex="0"], button, a[href]')
          : anchorElement;
      focusable?.focus?.();
    },
    []
  );

  const onLeaveRef = useRef(onLeave);
  // eslint-disable-next-line react-hooks/refs -- the panel's key handler must call the latest onLeave
  onLeaveRef.current = onLeave;

  useEffect(() => {
    if (!panel) return;
    // Listens on the document, not the card: a click on the scrim or anything else that drops focus to
    // the page behind must not let Tab walk out of a dialog that declares itself modal, or Escape stop
    // closing it.
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      const cardElement = cardRef.current;
      if (!cardElement) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onLeaveRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const stops = Array.from(cardElement.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = stops[0] ?? cardElement;
      const last = stops[stops.length - 1] ?? cardElement;
      const active = document.activeElement;
      const outside = !cardElement.contains(active);
      const wraps = event.shiftKey ? active === first || active === cardElement : active === last;
      if (!outside && !wraps) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', onDocumentKeyDown, true);
  }, [panel]);

  // Keyboard focus follows the card into the pill (StepPill focuses itself) and back.
  const hide = () => setHidden(true);
  const show = () => {
    setHidden(false);
    requestAnimationFrame(() => {
      const shown = cardRef.current;
      (
        shown?.querySelector<HTMLElement>('[data-tutorial-primary]') ??
        shown?.querySelector<HTMLElement>('[data-testid="tutorial-coach-hide"]')
      )?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    hide();
  };

  const dockSide = placement === 'left' ? 'left' : 'right';
  const bottom = rect ? 0 : dockCard({ side: dockSide, card, viewport, obstacles: avoided });
  let position: { left: number; top: number } | { left: number; bottom: number } | { right: number; bottom: number } =
    placement === 'left' ? { left: DOCK, bottom } : { right: DOCK, bottom };
  if (rect) {
    const { left, top } = placeCard({
      target: union(pad(rect, RING_PAD), scopeRect),
      obstacles: [...toasts, ...avoided],
      card,
      viewport,
      prefer: placement,
    });
    position = { left, top };
  }
  const label = progress ? `Step ${progress.index} of ${progress.count}` : heading;
  const frame = panel
    ? {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
        maxHeight: `calc(100dvh - ${EDGE * 2}px)`,
        overflowY: 'auto',
        p: { xs: 2, sm: 3 },
      }
    : { ...position, width: `min(${cardWidth}px, calc(100vw - ${EDGE * 2}px))`, p: 2 };

  return (
    <>
      {panel && (
        <Box
          data-testid="tutorial-panel-scrim"
          {...a11y({ ariaHidden: true })}
          // A click on the scrim would otherwise move focus to the page behind the modal panel.
          onMouseDown={event => event.preventDefault()}
          sx={{ position: 'fixed', inset: 0, bgcolor: 'rgba(0, 0, 0, 0.45)', zIndex: LAYER }}
        />
      )}
      {rect && (
        <Box
          data-testid="tutorial-anchor-ring"
          data-pulsing={pressed ? undefined : 'true'}
          {...a11y({ ariaHidden: true })}
          sx={{
            position: 'fixed',
            top: rect.top - RING_PAD,
            left: rect.left - RING_PAD,
            width: rect.right - rect.left + RING_PAD * 2,
            height: rect.bottom - rect.top + RING_PAD * 2,
            border: '2px solid',
            borderColor: 'primary.solidBg',
            borderRadius: 'md',
            pointerEvents: 'none',
            zIndex: LAYER,
            ...(pressed
              ? {}
              : {
                  animation: `${ringPulse} 1.6s ease-out infinite`,
                  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
                }),
          }}
        />
      )}
      <Sheet
        ref={cardRef}
        role="dialog"
        {...a11y({
          ...(title ? { ariaLabelledby: titleId } : { ariaLabel: 'Tutorial' }),
          ariaModal: panel || undefined,
        })}
        data-testid="tutorial-coach-card"
        variant="outlined"
        // The panel's keys are handled on the document (see the effect above).
        onKeyDown={panel ? undefined : onKeyDown}
        tabIndex={panel ? -1 : undefined}
        data-layout={panel ? 'panel' : undefined}
        sx={{
          position: 'fixed',
          ...frame,
          // Not display:none, so the card keeps its measured size and returns where it belongs.
          ...(hidden ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
          // Its own surface, so the card does not read as one more panel or canvas node of the app: the
          // selected session row's tint, laid over the opaque surface since the tint itself is translucent.
          // The tint is the host theme's own token; Joy's default theme (as in unit tests) has no such palette.
          background: theme => {
            const surface = theme.vars.palette.background.surface;
            const tint: string | undefined = theme.palette.notebooklist?.focusedBackground;
            return tint ? `linear-gradient(${tint}, ${tint}), ${surface}` : surface;
          },
          borderColor: 'neutral.outlinedBorder',
          borderRadius: 'md',
          boxShadow: 'lg',
          zIndex: LAYER,
        }}
      >
        <Stack direction="row" alignItems="flex-start" gap={1}>
          <Stack gap={0.75} sx={{ flex: 1, minWidth: 0 }}>
            {onShowSteps ? (
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={onShowSteps}
                data-testid="tutorial-coach-steps"
                sx={{
                  alignSelf: 'flex-start',
                  minHeight: 0,
                  px: 0.5,
                  py: 0.25,
                  mx: -0.5,
                  fontSize: 'xs',
                  fontWeight: 'md',
                }}
              >
                {label ?? 'Steps'}
              </Button>
            ) : (
              label && (
                <Typography level="body-xs" data-testid="tutorial-coach-progress">
                  {label}
                </Typography>
              )
            )}
            {title && (
              <Typography
                id={titleId}
                level={panel ? 'h3' : 'title-sm'}
                sx={{ whiteSpace: 'pre-line', textWrap: 'balance' }}
              >
                {title}
              </Typography>
            )}
            <Typography level={panel ? 'body-md' : 'body-sm'}>{body}</Typography>
          </Stack>
          {panel ? (
            <IconButton
              size="sm"
              variant="plain"
              {...a11y({ ariaLabel: 'Leave tutorial' })}
              data-testid="tutorial-coach-leave"
              onClick={onLeave}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          ) : (
            <IconButton
              size="sm"
              variant="plain"
              {...a11y({ ariaLabel: 'Hide card' })}
              data-testid="tutorial-coach-hide"
              onClick={hide}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Stack>
        {children && <Box sx={{ mt: 1.5, '&:empty': { display: 'none' } }}>{children}</Box>}
        {!panel && (
          <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onLeave}
              data-testid="tutorial-coach-leave"
              sx={{ minHeight: 0, px: 0.5, py: 0.25, mr: -0.5, fontSize: 'xs', fontWeight: 'md' }}
            >
              Leave tutorial
            </Button>
          </Stack>
        )}
      </Sheet>
      {hidden && (
        <StepPill
          label={label}
          side={dockSide}
          viewport={viewport}
          avoided={[...pillAvoided, ...avoided]}
          onShow={show}
        />
      )}
    </>
  );
}
