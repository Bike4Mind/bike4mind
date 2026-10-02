import type { BrowserPaneBounds } from '@shared/ipc';

/**
 * Whether the agent's browser is showing, remembered per machine.
 *
 * Window chrome rather than anything about a conversation - the same reasoning, the same key
 * prefix and the same blocked-storage fallback as the task panel flags in backgroundTasks.ts.
 * Off until it is asked for: a pane that takes half the window has to be opened deliberately.
 */
const STORAGE_KEY = 'b4m.browserPane.open';

export function readBrowserPaneOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Storage blocked. Closed for this run, which is the default anyway.
    return false;
  }
}

export function writeBrowserPaneOpen(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
}

/**
 * How wide the pane opens.
 *
 * A page rendered at the pane's width is the page the agent then snapshots, so this is not
 * only a layout number: under about 500px most sites switch to their phone layout, and the
 * agent would be reading a different page than the one it was asked about. It still has to
 * leave the conversation usable on a 1280px window beside a 280px sidebar, which is what puts
 * it here rather than higher.
 */
export const BROWSER_PANE_WIDTH = 560;

/**
 * The most of the window the pane may ever take.
 *
 * Without it the conversation, which is `flex: 1` over `minWidth: 0`, gives up every pixel the
 * pane asks for: on a 900px window beside an open sidebar that left the transcript sixty pixels
 * wide. The pane yields first instead, and the page goes to its phone layout, which is the
 * honest outcome - at that size the two cannot both be read, and the window is the thing to
 * widen.
 */
export const BROWSER_PANE_MAX_FRACTION = '42vw';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** As much of a body child as this needs to know: `Element` satisfies it. */
interface OverlayLayer {
  id: string;
  getBoundingClientRect(): Rect;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The layers drawn OVER the app - every modal, menu, tooltip and popper MUI portals out of the
 * React tree and appends to the body.
 *
 * Found structurally rather than by class name: the one thing every such layer has in common is
 * that it is a child of the body and is not the app's own root, and that holds whether it came
 * from Joy, from a future component, or from a library that does its own portalling.
 *
 * This matters more than it looks. A `WebContentsView` is a native overlay: it paints above
 * everything the renderer draws, so an approval card, a model menu or a tooltip that happens to
 * fall over the pane would be INVISIBLE behind a web page, and an approval the user cannot see
 * is not a cosmetic bug. Anything that overlaps the pane therefore takes the pane off screen
 * for as long as it is up.
 */
export function overlayRects(children: readonly OverlayLayer[], rootId: string): Rect[] {
  return children
    .filter(child => child.id !== rootId)
    .map(child => child.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0);
}

/** Whether anything drawn over the app is sitting on the pane's rectangle. */
export function coveredByOverlay(pane: Rect, overlays: readonly Rect[]): boolean {
  return overlays.some(rect => overlaps(pane, rect));
}

/** A measured rectangle as main wants it: window-relative and whole pixels. */
export function toPaneBounds(rect: Rect): BrowserPaneBounds {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Whether two reports are the same, so an observer that fires on every frame sends one call. */
export function sameBounds(a: BrowserPaneBounds | null, b: BrowserPaneBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
