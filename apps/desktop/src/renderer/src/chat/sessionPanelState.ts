import { useCallback, useEffect, useRef, useState } from 'react';
import { COLUMN_PADDING, CONTENT_MAX_WIDTH } from './layout';

/**
 * The session panel's sections, in the order they are drawn. Adding one is a new id here and a
 * new entry where SessionPanel builds its list.
 */
export const SESSION_PANEL_SECTIONS = ['environment', 'context', 'changes', 'plan', 'background'] as const;
export type SessionPanelSectionId = (typeof SESSION_PANEL_SECTIONS)[number];

/** The docked card's width, in px. */
export const SESSION_PANEL_WIDTH = 280;
/** Gap between the card and the edges of the thread it floats over, in px. */
export const SESSION_PANEL_INSET = 12;

/**
 * Whether the docked card fits beside the reading column without covering any of its text.
 *
 * The column is centred and capped at CONTENT_MAX_WIDTH, so what is free on its right is half of
 * whatever the pane has beyond that, plus the column's own padding. Below this the card folds into
 * its header button and opens as a popover instead.
 */
export function panelFitsBesideThread(columnWidth: number): boolean {
  const freeOnRight = (columnWidth - CONTENT_MAX_WIDTH) / 2 + COLUMN_PADDING;
  return freeOnRight >= SESSION_PANEL_WIDTH + 2 * SESSION_PANEL_INSET;
}

/**
 * Per-machine window chrome, so localStorage rather than the session file - the same reasoning as
 * the background task panel's flags (backgroundTasks.ts). Open by default: the panel is where a
 * Code session's branch, changes and PR live, and hiding them has to be a choice.
 */
const OPEN_KEY = 'b4m.sessionPanel.open';
const COLLAPSED_KEY = 'b4m.sessionPanel.collapsed';

function isSectionId(value: unknown): value is SessionPanelSectionId {
  return typeof value === 'string' && (SESSION_PANEL_SECTIONS as readonly string[]).includes(value);
}

export function readSessionPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    // Storage blocked: the default, for this run.
    return true;
  }
}

export function writeSessionPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
}

/** The sections the user has folded. Anything unreadable, or not a section this build knows, is dropped. */
export function readCollapsedSections(): ReadonlySet<SessionPanelSectionId> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter(isSectionId) : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedSections(collapsed: ReadonlySet<SessionPanelSectionId>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // As above.
  }
}

export interface SessionPanelPrefs {
  open: boolean;
  toggleOpen: () => void;
  collapsed: ReadonlySet<SessionPanelSectionId>;
  toggleSection: (id: SessionPanelSectionId) => void;
}

/** The remembered open flag and folded sections, seeded from storage and written back on change. */
export function useSessionPanelPrefs(): SessionPanelPrefs {
  const [open, setOpen] = useState(readSessionPanelOpen);
  const [collapsed, setCollapsed] = useState(readCollapsedSections);

  const toggleOpen = useCallback(() => {
    setOpen(current => {
      writeSessionPanelOpen(!current);
      return !current;
    });
  }, []);

  const toggleSection = useCallback((id: SessionPanelSectionId) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      writeCollapsedSections(next);
      return next;
    });
  }, []);

  return { open, toggleOpen, collapsed, toggleSection };
}

/**
 * An element's width, followed as it changes; null until measured, or where there is no
 * ResizeObserver to measure with (the test DOM), which callers read as "wide enough".
 *
 * A callback ref rather than an effect on a ref object: the element mounts and unmounts with the
 * conversation screen, and an effect keyed on a stable ref object would never see it come back.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    setWidth(node.getBoundingClientRect().width);
    const next = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    next.observe(node);
    observer.current = next;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, width];
}
