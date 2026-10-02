import { describe, expect, it } from 'vitest';
import { coveredByOverlay, overlaps, overlayRects, sameBounds, toPaneBounds } from './agentBrowser';

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

/** A stand-in for a body child, since the helper only asks for its id and its rectangle. */
function child(id: string, rect: { x: number; y: number; width: number; height: number }) {
  return { id, getBoundingClientRect: () => rect };
}

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
