// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONTENT_MAX_WIDTH } from './layout';
import {
  parseReplyStatsPrefs,
  railFitsBesideThread,
  reloadReplyStatsPrefs,
  replyStatsSummary,
  REPLY_STATS_RAIL_INSET,
  REPLY_STATS_RAIL_WIDTH,
  setReplyStatShown,
  setReplyStatsRail,
  useReplyStatsPrefs,
} from './replyStatsPrefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  reloadReplyStatsPrefs();
});

describe('a change made in another window', () => {
  it('reaches this one through the storage event', () => {
    let rail: boolean | null = null;
    function Probe() {
      rail = useReplyStatsPrefs().rail;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    expect(rail).toBe(true);

    window.localStorage.setItem('b4m.chat.replyStats.rail', '0');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'b4m.chat.replyStats.rail' })));
    expect(rail).toBe(false);

    window.localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(rail).toBe(true);
    act(() => root.unmount());
  });
});

describe('railFitsBesideThread', () => {
  // Free on the left is half the region beyond the column, plus the column's 24px padding.
  const threshold = CONTENT_MAX_WIDTH + 2 * (REPLY_STATS_RAIL_WIDTH + 2 * REPLY_STATS_RAIL_INSET - 24);
  const sidebar = { collapsed: 45, standard: 281, widest: 481 };

  it('fits from a 1176px thread region', () => {
    expect(threshold).toBe(1176);
    expect(railFitsBesideThread(1176)).toBe(true);
    expect(railFitsBesideThread(1175)).toBe(false);
  });

  it('turns on at the 1280 default window only once the sidebar is collapsed', () => {
    expect(railFitsBesideThread(1280 - sidebar.standard)).toBe(false);
    expect(railFitsBesideThread(1280 - sidebar.collapsed)).toBe(true);
  });

  it('does not fit a thread region that has not been measured yet', () => {
    expect(railFitsBesideThread(null)).toBe(false);
  });

  it('needs a wider window for a wider sidebar', () => {
    expect(railFitsBesideThread(1657 - sidebar.widest)).toBe(true);
    expect(railFitsBesideThread(1656 - sidebar.widest)).toBe(false);
    expect(railFitsBesideThread(1457 - sidebar.standard)).toBe(true);
  });
});

describe('parseReplyStatsPrefs', () => {
  it('starts with the rail on and every stat shown', () => {
    const prefs = parseReplyStatsPrefs(null, null, null);
    expect(prefs.rail).toBe(true);
    expect(prefs.hidden.size).toBe(0);
  });

  it('carries the old tok/s switch over as the speed stat unticked', () => {
    expect([...parseReplyStatsPrefs(null, null, '0').hidden]).toEqual(['speed']);
    expect(parseReplyStatsPrefs(null, null, '1').hidden.size).toBe(0);
    expect(parseReplyStatsPrefs(null, '[]', '0').hidden.size).toBe(0);
  });

  it('drops what it cannot read, and stats this build does not know', () => {
    expect([...parseReplyStatsPrefs('0', '["load","later-stat",3]', null).hidden]).toEqual(['load']);
    expect(parseReplyStatsPrefs('0', '{not json', null)).toEqual({ rail: false, hidden: new Set() });
  });
});

describe('the stored prefs', () => {
  it('remember the rail and the unticked stats across a relaunch', () => {
    setReplyStatsRail(false);
    setReplyStatShown('load', false);
    setReplyStatShown('thinking', false);
    setReplyStatShown('thinking', true);
    reloadReplyStatsPrefs();

    const prefs = parseReplyStatsPrefs(
      window.localStorage.getItem('b4m.chat.replyStats.rail'),
      window.localStorage.getItem('b4m.chat.replyStats.hidden'),
      null
    );
    expect(prefs).toEqual({ rail: false, hidden: new Set(['load']) });
  });

  it('summarise both in one line', () => {
    expect(replyStatsSummary({ rail: true, hidden: new Set() })).toBe(
      'All stats, beside the conversation when the window is wide enough'
    );
    expect(replyStatsSummary({ rail: false, hidden: new Set(['load', 'speed']) })).toBe(
      '9 of 11 stats, under each reply on hover'
    );
  });
});
