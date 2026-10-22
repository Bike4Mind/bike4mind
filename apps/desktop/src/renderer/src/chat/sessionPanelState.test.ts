// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_MAX_WIDTH } from './layout';
import {
  SESSION_PANEL_INSET,
  SESSION_PANEL_WIDTH,
  panelFitsBesideThread,
  readCollapsedSections,
  readSessionPanelOpen,
  writeCollapsedSections,
  writeSessionPanelOpen,
} from './sessionPanelState';

beforeEach(() => window.localStorage.clear());

describe('panelFitsBesideThread', () => {
  // Free on the right is half the pane beyond the column, plus the column's 24px padding.
  const threshold = CONTENT_MAX_WIDTH + 2 * (SESSION_PANEL_WIDTH + 2 * SESSION_PANEL_INSET - 24);

  it('docks once the card fits beside the reading column', () => {
    expect(panelFitsBesideThread(threshold)).toBe(true);
    expect(panelFitsBesideThread(threshold + 400)).toBe(true);
  });

  it('folds into a popover below that, rather than covering text', () => {
    expect(panelFitsBesideThread(threshold - 1)).toBe(false);
    expect(panelFitsBesideThread(CONTENT_MAX_WIDTH)).toBe(false);
    expect(panelFitsBesideThread(0)).toBe(false);
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
