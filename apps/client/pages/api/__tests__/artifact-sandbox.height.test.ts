import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../artifact-sandbox';

/**
 * The emitted sandbox measures its own page and posts the height to the parent, which sizes
 * the frame from it. That makes the measurement a feedback path: anything that tracks the
 * frame's height grows the frame, which grows the viewport, which grows the number.
 *
 * So these cases run the real reporting loop rather than one measurement - report, let the
 * parent resize the frame exactly as InlineArtifactPreview does, report again - and assert it
 * settles. A page is described by the rects of `<body>`'s children, each of which may be a
 * function of the current viewport; that is what a `min-height: 100vh` wrapper is, and a
 * fixture that cannot express it is how the first version of this fix passed while the loop
 * was still live for a viewport-tall child.
 */

const COLLAPSED_MAX = 420; // HtmlArtifactPreviewCard's maxHeight
const CLAMP = 2400; // HTML_PREVIEW_MAX_HEIGHT in InlineArtifactPreview

function emittedPage(): string {
  let body = '';
  const res = {
    setHeader: () => undefined,
    status: () => res,
    send: (payload: string) => {
      body = payload ?? '';
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET', headers: {}, query: {} } as unknown as NextApiRequest, res);
  return body;
}

/** The measure-and-report block, lifted out of the emitted page so it can be driven alone. */
function reporterSource(): string {
  const page = emittedPage();
  const start = page.indexOf('var lastReportedHeight = 0;');
  expect(start, 'the reporter is no longer emitted - update this test').toBeGreaterThan(-1);
  const end = page.indexOf('function watchHeight()', start);
  expect(end, 'watchHeight no longer follows the reporter').toBeGreaterThan(start);
  return page.slice(start, end);
}

interface Child {
  /** Bottom edge in document coordinates, given the current viewport. */
  bottom: (viewport: number) => number;
  position?: string;
}

interface Page {
  children: Child[];
  /** body's own margin/padding, the space a child's rect sits inside. */
  margin?: number;
  padding?: number;
}

interface Run {
  reports: number[];
  frames: number[];
  settled: boolean;
}

/**
 * Drives the reporter against `page`, resizing the frame on each report the way the parent
 * does. `expanded` picks which of the parent's two rules applies (InlineArtifactPreview:
 * collapsed clamps to maxHeight, expanded clamps to HTML_PREVIEW_MAX_HEIGHT).
 */
function run(page: Page, { expanded = false, ticks = 40 } = {}): Run {
  const margin = page.margin ?? 0;
  const padding = page.padding ?? 0;
  let viewport = COLLAPSED_MAX;
  const reports: number[] = [];
  const frames: number[] = [];

  const elements = page.children.map(c => ({
    getBoundingClientRect: () => ({ bottom: c.bottom(viewport) }),
    __position: c.position ?? 'static',
  }));

  const context = vm.createContext({
    document: {
      body: {
        children: elements,
        get scrollHeight() {
          return viewport;
        },
      },
      get documentElement() {
        return { scrollHeight: viewport };
      },
    },
    window: {
      get innerHeight() {
        return viewport;
      },
      scrollY: 0,
      pageYOffset: 0,
      getComputedStyle: (el: { __position?: string }) =>
        el && el.__position !== undefined
          ? { position: el.__position, paddingBottom: '0px', marginBottom: '0px' }
          : {
              position: 'static',
              marginTop: margin + 'px',
              marginBottom: margin + 'px',
              paddingTop: padding + 'px',
              paddingBottom: padding + 'px',
            },
      parent: {
        postMessage: (msg: { height: number }) => {
          reports.push(msg.height);
          viewport = expanded ? Math.min(msg.height, CLAMP) : Math.min(msg.height, COLLAPSED_MAX);
          frames.push(viewport);
        },
      },
    },
  });
  vm.runInContext(reporterSource(), context);

  for (let i = 0; i < ticks; i++) vm.runInContext('reportHeight()', context);
  // Settled if the last handful of ticks produced no new report.
  const before = reports.length;
  for (let i = 0; i < 5; i++) vm.runInContext('reportHeight()', context);
  return { reports, frames, settled: reports.length === before };
}

/** The shape the round-1 fix handled: <body> itself is viewport-tall. */
const viewportTallBody = (margin: number): Page => ({
  margin,
  children: [{ bottom: v => v }],
});

/** The shape it did not: a full-screen wrapper INSIDE <body>, which is the common one. */
const viewportTallChild = (margin: number): Page => ({
  margin,
  children: [{ bottom: v => v + margin }],
});

/**
 * The same loop, but overshooting by more than the body's own box, so the "it fits" rule
 * cannot reach it and only the echo check can stop it. This is the second shape from review:
 * `html, body, .app { height: 100% }` with an h1 whose top margin collapses through the
 * wrapper - no body margin at all, and roughly 22px of overshoot that is not body padding.
 */
const viewportTallChildBeyondSlack = (): Page => ({
  margin: 0,
  children: [{ bottom: v => v + 22 }],
});

describe('artifact sandbox height reporting', () => {
  it('settles on a viewport-tall wrapper inside body, the standard full-screen page', () => {
    // `<div class="app" style="min-height:100vh">` under the browser-default 8px body margin.
    // Before the echo check this climbed 16px per report until it hit the 2400 clamp.
    const collapsed = run(viewportTallChild(8));
    expect(collapsed.settled).toBe(true);
    expect(collapsed.reports.length).toBeLessThanOrEqual(2);
    // It fits, so the frame must never exceed the collapsed bound.
    expect(Math.max(...collapsed.frames)).toBeLessThanOrEqual(COLLAPSED_MAX);
  });

  it('does not offer "show more" for a full-screen wrapper that fits', () => {
    // The parent's rule, verbatim from InlineArtifactPreview.
    const { reports } = run(viewportTallChild(8));
    const overflows = reports.some(h => h > COLLAPSED_MAX + 8);
    expect(overflows).toBe(false);
  });

  it('cannot be driven past the clamp even once expanded', () => {
    const { frames, settled } = run(viewportTallChild(8), { expanded: true });
    expect(settled).toBe(true);
    expect(Math.max(...frames)).toBeLessThan(CLAMP);
  });

  it('settles a viewport-tracking child that overshoots by more than the body box', () => {
    // Only the echo check can catch this one - the overshoot is not body margin or padding,
    // so the "it fits" rule does not apply. Without the echo check it climbs to the clamp.
    const { frames, settled, reports } = run(viewportTallChildBeyondSlack(), { expanded: true });
    expect(settled).toBe(true);
    expect(Math.max(...frames)).toBeLessThan(CLAMP);
    // One report, then every echo of the parent's own resize is dropped.
    expect(reports.length).toBeLessThanOrEqual(2);
  });

  it('still settles when body itself is the viewport-tall element', () => {
    const { reports, settled } = run(viewportTallBody(8));
    expect(settled).toBe(true);
    expect(reports.length).toBeLessThanOrEqual(2);
  });

  it('reports a genuinely tall page at its real height and stops there', () => {
    const { reports, frames, settled } = run({ children: [{ bottom: () => 1460 }] }, { expanded: true });
    expect(settled).toBe(true);
    expect(reports[0]).toBe(1460);
    expect(frames[frames.length - 1]).toBe(1460);
  });

  it('still offers "show more" when there really is more', () => {
    const { reports } = run({ children: [{ bottom: () => 916 }] });
    expect(reports.some(h => h > COLLAPSED_MAX + 8)).toBe(true);
  });

  it('takes the lowest child, not the last one', () => {
    const { reports } = run({ children: [{ bottom: () => 900 }, { bottom: () => 200 }] });
    expect(reports[0]).toBe(900);
  });

  it('ignores fixed children, whose rects are anchored to the viewport', () => {
    const { reports, settled } = run({
      children: [{ bottom: () => 150 }, { bottom: v => v, position: 'fixed' }],
    });
    expect(settled).toBe(true);
    // 150 is under the viewport, so it is reported as fitting rather than as 150.
    expect(Math.max(...reports)).toBeLessThanOrEqual(COLLAPSED_MAX);
  });

  it('vacuity: a viewport-tracking child does drive the OLD measurement without end', () => {
    // If this ever stops holding, the cases above prove nothing.
    let viewport = COLLAPSED_MAX;
    const legacy = () => viewport + 16;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const h = legacy();
      seen.push(h);
      viewport = Math.min(h, CLAMP);
    }
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0] + 200);
  });
});
