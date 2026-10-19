// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  avoidPageModifier,
  coveredByOverlay,
  overlaps,
  overlayRects,
  reservePageArea,
  sameBounds,
  toPaneBounds,
} from './agentBrowser';

const pane = { x: 800, y: 60, width: 400, height: 700 };

describe('overlaps', () => {
  it('is true for a rectangle that lands on the pane', () => {
    expect(overlaps(pane, { x: 700, y: 400, width: 200, height: 100 })).toBe(true);
  });

  it('is false for one that stops at its edge', () => {
    expect(overlaps(pane, { x: 500, y: 400, width: 300, height: 100 })).toBe(false);
  });

  it('is false for one above the pane', () => {
    expect(overlaps(pane, { x: 850, y: 0, width: 200, height: 60 })).toBe(false);
  });
});

describe('coveredByOverlay', () => {
  it('reports a modal backdrop, which covers everything', () => {
    expect(coveredByOverlay(pane, [{ x: 0, y: 0, width: 1280, height: 860 }])).toBe(true);
  });

  it('leaves the pane alone for a menu that opened over the conversation', () => {
    expect(coveredByOverlay(pane, [{ x: 320, y: 500, width: 220, height: 180 }])).toBe(false);
  });

  it('is false with nothing drawn over the app at all', () => {
    expect(coveredByOverlay(pane, [])).toBe(false);
  });
});

/** A body child at `rect`, since jsdom lays nothing out. */
function child(id: string, rect: { x: number; y: number; width: number; height: number }, html = '', role = '') {
  const element = document.createElement('div');
  element.id = id;
  if (role) element.setAttribute('role', role);
  element.innerHTML = html;
  element.getBoundingClientRect = () => rect as DOMRect;
  return element;
}

const overPane = { x: 700, y: 400, width: 200, height: 100 };

describe('overlayRects', () => {
  it('skips the app root and takes every other layer', () => {
    const rects = overlayRects(
      [child('root', { x: 0, y: 0, width: 1280, height: 860 }), child('', { x: 100, y: 100, width: 200, height: 50 })],
      'root'
    );
    expect(rects).toEqual([{ x: 100, y: 100, width: 200, height: 50 }]);
  });

  it('skips a layer with no size, which is a portal container holding nothing yet', () => {
    expect(overlayRects([child('', { x: 0, y: 0, width: 0, height: 0 })], 'root')).toEqual([]);
  });

  it('skips a tooltip that only shows text, even one lying over the pane', () => {
    const tooltip = child('', overPane, 'Context 27k / 400k<br>Last turn 3k', 'tooltip');
    expect(coveredByOverlay(pane, overlayRects([tooltip], 'root'))).toBe(false);
  });

  it('still takes a tooltip role layer holding something to click or focus', () => {
    for (const html of ['<button>Approve</button>', '<a href="#x">Open</a>', '<div tabindex="0">x</div>']) {
      expect(overlayRects([child('', overPane, html, 'tooltip')], 'root')).toEqual([overPane]);
    }
  });

  it('still takes menus, listboxes and modals', () => {
    const layers = [
      child('', overPane, '<li role="menuitem" tabindex="-1">GPT-5</li>', 'menu'),
      child('', overPane, '<li role="option">High</li>', 'listbox'),
      child('', { x: 0, y: 0, width: 1280, height: 860 }, '<div role="dialog"></div>', 'presentation'),
    ];
    expect(overlayRects(layers, 'root')).toHaveLength(3);
  });
});

describe('avoidPageModifier', () => {
  afterEach(() => reservePageArea(null));

  /** Popper's state, as far as the modifier reads it: where the popper is about to go. */
  const run = (x: number, y: number, width: number, height: number, reference = { x: 600, width: 24 }) => {
    const popperOffsets = { x, y };
    avoidPageModifier.fn({
      state: { rects: { popper: { width, height }, reference }, modifiersData: { popperOffsets } },
    });
    return popperOffsets;
  };

  it('slides a tooltip that would reach onto the page back to the left of it', () => {
    reservePageArea(pane);
    expect(run(560, 640, 300, 40)).toEqual({ x: pane.x - 8 - 300, y: 640 });
  });

  it('leaves one that is clear of the page where Popper put it', () => {
    reservePageArea(pane);
    expect(run(200, 640, 300, 40)).toEqual({ x: 200, y: 640 });
    expect(run(900, 10, 200, 40)).toEqual({ x: 900, y: 10 });
  });

  it("never pushes past the window's left edge", () => {
    reservePageArea(pane);
    expect(run(560, 640, 900, 40).x).toBe(8);
  });

  it("leaves a menu opened from the pane's own chrome by its button", () => {
    reservePageArea(pane);
    expect(run(900, 70, 240, 120, { x: 1150, width: 30 })).toEqual({ x: 900, y: 70 });
  });

  it('does nothing with no pane open', () => {
    expect(run(900, 640, 300, 40)).toEqual({ x: 900, y: 640 });
  });
});

describe('toPaneBounds', () => {
  it('rounds to whole pixels, which is what setBounds takes', () => {
    expect(toPaneBounds({ x: 719.5, y: 60.2, width: 560.4, height: 799.6 })).toEqual({
      x: 720,
      y: 60,
      width: 560,
      height: 800,
    });
  });
});

describe('sameBounds', () => {
  const bounds = { x: 1, y: 2, width: 3, height: 4 };

  it('matches two equal rectangles', () => {
    expect(sameBounds(bounds, { ...bounds })).toBe(true);
  });

  it('separates a move from a stay', () => {
    expect(sameBounds(bounds, { ...bounds, x: 2 })).toBe(false);
  });

  it('treats hidden as its own value, not as any rectangle', () => {
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(null, bounds)).toBe(false);
  });
});
