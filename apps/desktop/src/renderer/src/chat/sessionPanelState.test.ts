// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLUMN_PADDING, CONTENT_MAX_WIDTH } from './layout';
import {
  SESSION_PANEL_BESIDE_MIN_WIDTH,
  SESSION_PANEL_PUSH_MIN_WIDTH,
  SESSION_PANEL_SPACE,
  sessionPanelLayout,
  readCollapsedSections,
  readSessionPanelOpen,
  writeCollapsedSections,
  writeSessionPanelOpen,
} from './sessionPanelState';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('sessionPanelLayout', () => {
  const centered = { centeredColumn: true };
  const stage = { centeredColumn: false };

  it('floats in the margin once the centered column leaves room for the whole card', () => {
    // The card may sit over the column's padding, never its text.
    expect(SESSION_PANEL_BESIDE_MIN_WIDTH).toBe(CONTENT_MAX_WIDTH + 2 * (SESSION_PANEL_SPACE - COLUMN_PADDING));
    expect(sessionPanelLayout(SESSION_PANEL_BESIDE_MIN_WIDTH, centered)).toBe('beside');
    expect(sessionPanelLayout(2400, centered)).toBe('beside');
  });

  it('pushes the column when only the rail and a full reading column fit', () => {
    expect(SESSION_PANEL_PUSH_MIN_WIDTH).toBe(CONTENT_MAX_WIDTH + SESSION_PANEL_SPACE);
    expect(sessionPanelLayout(SESSION_PANEL_BESIDE_MIN_WIDTH - 1, centered)).toBe('push');
    expect(sessionPanelLayout(SESSION_PANEL_PUSH_MIN_WIDTH, centered)).toBe('push');
  });

  it('overlays the thread below that, rather than squeezing the reading column', () => {
    expect(sessionPanelLayout(SESSION_PANEL_PUSH_MIN_WIDTH - 1, centered)).toBe('overlay');
    expect(sessionPanelLayout(CONTENT_MAX_WIDTH, centered)).toBe('overlay');
    expect(sessionPanelLayout(0, centered)).toBe('overlay');
  });

  it('never floats without a centered column, since the stage has no free margin', () => {
    expect(sessionPanelLayout(2400, stage)).toBe('push');
    expect(sessionPanelLayout(SESSION_PANEL_PUSH_MIN_WIDTH, stage)).toBe('push');
    expect(sessionPanelLayout(SESSION_PANEL_PUSH_MIN_WIDTH - 1, stage)).toBe('overlay');
  });

  it('treats a region not yet measured as wide', () => {
    expect(sessionPanelLayout(null, centered)).toBe('beside');
    expect(sessionPanelLayout(null, stage)).toBe('push');
  });
});

describe('the remembered open flag', () => {
  it('is open until the user closes it, and remembers either way', () => {
    expect(readSessionPanelOpen()).toBe(true);
    writeSessionPanelOpen(false);
    expect(readSessionPanelOpen()).toBe(false);
    writeSessionPanelOpen(true);
    expect(readSessionPanelOpen()).toBe(true);
  });
});

describe('the remembered folded sections', () => {
  it('round-trips through storage', () => {
    writeCollapsedSections(new Set(['plan', 'environment']));
    expect([...readCollapsedSections()].sort()).toEqual(['environment', 'plan']);
  });

  it('drops anything it does not recognise instead of throwing', () => {
    window.localStorage.setItem('b4m.sessionPanel.collapsed', JSON.stringify(['plan', 'connectors', 7]));
    expect([...readCollapsedSections()]).toEqual(['plan']);
    window.localStorage.setItem('b4m.sessionPanel.collapsed', '{not json');
    expect(readCollapsedSections().size).toBe(0);
  });
});

describe('storage that throws', () => {
  it('falls back to the defaults on read and swallows writes', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(readSessionPanelOpen()).toBe(true);
    expect(readCollapsedSections().size).toBe(0);
    expect(() => writeSessionPanelOpen(false)).not.toThrow();
    expect(() => writeCollapsedSections(new Set(['plan']))).not.toThrow();
  });
});
