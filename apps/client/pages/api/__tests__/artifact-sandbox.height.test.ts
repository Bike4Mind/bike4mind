import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../artifact-sandbox';

/**
 * The emitted sandbox measures its own page and posts the height to the parent, which sizes
 * the frame from it. That makes the measurement a feedback path: anything viewport-derived
 * in the number grows the frame, which grows the viewport, which grows the number.
 *
 * These cases pin the measurement against a fake document whose body tracks the viewport
 * (what `body { min-height: 100vh }` does) while its children do not.
 */

function emittedScript(): string {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: () => res,
    send: (payload: string) => {
      body = payload ?? '';
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET', headers: {}, query: {} } as unknown as NextApiRequest, res);
  return body;
}

/** The `contentHeight` declaration, lifted out of the emitted page so it can be run alone. */
function contentHeightSource(): string {
  const page = emittedScript();
  const start = page.indexOf('function contentHeight()');
  expect(start, 'contentHeight is no longer emitted - update this test').toBeGreaterThan(-1);
  const end = page.indexOf('\n  function reportHeight()', start);
  expect(end, 'reportHeight no longer follows contentHeight').toBeGreaterThan(start);
  return page.slice(start, end);
}

interface Child {
  bottom: number;
  position?: string;
}

/**
 * A document whose body is exactly as tall as the viewport plus its margins, so every
 * viewport-derived measurement climbs when the frame grows.
 */
function measureAt(viewport: number, children: Child[]): number {
  const BODY_MARGIN = 16;
  const elements = children.map(c => ({
    getBoundingClientRect: () => ({ bottom: c.bottom }),
    __position: c.position ?? 'static',
  }));
  const body = {
    children: elements,
    get scrollHeight() {
      return viewport + BODY_MARGIN;
    },
  };
  const context = vm.createContext({
    document: {
      body,
      documentElement: {
        get scrollHeight() {
          return viewport;
        },
      },
    },
    window: {
      scrollY: 0,
      pageYOffset: 0,
      getComputedStyle: (el: { __position?: string }) => ({
        position: el.__position ?? 'static',
        paddingBottom: '0px',
        marginBottom: '0px',
      }),
    },
  });
  vm.runInContext(contentHeightSource(), context);
  return vm.runInContext('contentHeight()', context) as number;
}

describe('artifact sandbox height measurement', () => {
  it('reports the content bottom, not the viewport, so growing the frame does not grow it', () => {
    const short = [{ bottom: 120 }];
    expect(measureAt(400, short)).toBe(120);
    // Same page, frame already expanded. A viewport-derived measurement would climb here;
    // this is the step that used to feed the runaway.
    expect(measureAt(2000, short)).toBe(120);
  });

  it('does not offer "show more" for a page that fits', () => {
    // The parent compares against maxHeight + 8, so a fitting page must measure at or below
    // its own content - a viewport-derived 416 against a 400 frame tripped this falsely.
    expect(measureAt(400, [{ bottom: 300 }])).toBeLessThanOrEqual(400);
  });

  it('still reports a tall page as tall', () => {
    expect(measureAt(400, [{ bottom: 1800 }])).toBe(1800);
  });

  it('takes the lowest child, not the last one', () => {
    expect(measureAt(400, [{ bottom: 900 }, { bottom: 200 }])).toBe(900);
  });

  it('ignores fixed children, whose rects are anchored to the viewport', () => {
    const withFixed = [{ bottom: 150 }, { bottom: 400, position: 'fixed' }];
    expect(measureAt(400, withFixed)).toBe(150);
    expect(measureAt(2000, withFixed)).toBe(150);
  });

  it('falls back to scrollHeight when there is nothing measurable to bound', () => {
    // A body with no element children cannot grow into anything, so the loop cannot start
    // and the old measurement is still the best available.
    expect(measureAt(400, [])).toBe(416);
  });

  it('vacuity: the old measurement does track the viewport, so the cases above are not idle', () => {
    const legacy = (viewport: number) => Math.max(viewport + 16, viewport);
    expect(legacy(400)).toBe(416);
    expect(legacy(2000)).toBe(2016);
  });
});
