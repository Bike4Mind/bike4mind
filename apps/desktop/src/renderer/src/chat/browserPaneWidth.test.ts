// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_PANE_WIDTH } from './agentBrowser';
import {
  BROWSER_PANE_MIN_WIDTH,
  browserPaneMaxWidth,
  clampBrowserPaneWidth,
  CONVERSATION_MIN_WIDTH,
  readBrowserPaneWidth,
  writeBrowserPaneWidth,
} from './browserPaneWidth';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('browserPaneMaxWidth', () => {
  it('is the window fraction when the conversation has room to spare', () => {
    expect(browserPaneMaxWidth(2000, 1600)).toBe(840);
  });

  it('leaves the conversation its minimum when the fixed columns take the rest', () => {
    expect(browserPaneMaxWidth(2000, 1000)).toBe(1000 - CONVERSATION_MIN_WIDTH);
  });

  it('does not let the conversation push the pane under its own minimum', () => {
    expect(browserPaneMaxWidth(1200, 500)).toBe(BROWSER_PANE_MIN_WIDTH);
  });

  // The pane yields first on a window too small for both; see BROWSER_PANE_MAX_FRACTION.
  it('lets the window fraction win below the minimum', () => {
    expect(browserPaneMaxWidth(600, 300)).toBe(252);
  });
});

describe('clampBrowserPaneWidth', () => {
  it('holds a width inside the bounds', () => {
    expect(clampBrowserPaneWidth(100, 800)).toBe(BROWSER_PANE_MIN_WIDTH);
    expect(clampBrowserPaneWidth(1200, 800)).toBe(800);
    expect(clampBrowserPaneWidth(640.4, 800)).toBe(640);
  });

  it('falls back rather than letting NaN out to a width', () => {
    expect(clampBrowserPaneWidth(Number.NaN)).toBe(BROWSER_PANE_WIDTH);
  });
});

describe('readBrowserPaneWidth', () => {
  it('is the default until something has been stored', () => {
    expect(readBrowserPaneWidth()).toBe(BROWSER_PANE_WIDTH);
  });

  it('round-trips a width the user dragged to', () => {
    writeBrowserPaneWidth(700);
    expect(readBrowserPaneWidth()).toBe(700);
  });

  it('ignores a value that is not a width at all', () => {
    window.localStorage.setItem('b4m.browserPane.width', 'wide');
    expect(readBrowserPaneWidth()).toBe(BROWSER_PANE_WIDTH);
  });

  it('falls back to the default when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readBrowserPaneWidth()).toBe(BROWSER_PANE_WIDTH);
  });

  it('does not throw out of a write when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeBrowserPaneWidth(700)).not.toThrow();
  });
});
