// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeSidebarWidth,
} from './sidebarWidth';

afterEach(() => window.localStorage.clear());

describe('clampSidebarWidth', () => {
  it('holds the drag inside the bounds', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 400)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('rounds, because a drag reports fractional pixels on a scaled display', () => {
    expect(clampSidebarWidth(317.6)).toBe(318);
  });

  it('falls back rather than letting NaN out to a width', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('readSidebarWidth', () => {
  it('is the default until something has been stored', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('round-trips a width the user dragged to', () => {
    writeSidebarWidth(344);
    expect(readSidebarWidth()).toBe(344);
  });

  // The bounds can move between releases; a width stored under the old ones cannot.
  it('clamps on the way out as well as in', () => {
    window.localStorage.setItem('b4m.sidebar.width', '4000');
    expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('ignores a value that is not a width at all', () => {
    window.localStorage.setItem('b4m.sidebar.width', 'wide');
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
