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

  it('follows a stat ticked or unticked there', () => {
    let hidden: ReadonlySet<string> = new Set();
    function Probe() {
      hidden = useReplyStatsPrefs().hidden;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    expect(hidden.has('speed')).toBe(false);

    window.localStorage.setItem('b4m.chat.replyStats.shown', JSON.stringify({ speed: false, load: true }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'b4m.chat.replyStats.shown' })));
    expect(hidden.has('speed')).toBe(true);
    expect(hidden.has('load')).toBe(false);
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
  const offByDefault = ['promptSpeed', 'firstToken', 'load', 'draft'];

  it('starts with the rail on, and every stat shown but the server timings and the first token', () => {
    const prefs = parseReplyStatsPrefs(null, null, null);
    expect(prefs.rail).toBe(true);
    expect([...prefs.hidden]).toEqual(offByDefault);
  });

  it('carries the old tok/s switch over as the speed stat unticked', () => {
    expect([...parseReplyStatsPrefs(null, null, '0').hidden]).toEqual(['speed', ...offByDefault]);
    expect([...parseReplyStatsPrefs(null, null, '1').hidden]).toEqual(offByDefault);
    expect([...parseReplyStatsPrefs(null, '{}', '0').hidden]).toEqual(offByDefault);
  });

  it('takes a choice either way over the default, and drops what it cannot read or does not know', () => {
    expect([...parseReplyStatsPrefs('0', '{"load":true,"total":false,"later":false,"speed":1}', null).hidden]).toEqual([
      'total',
      'promptSpeed',
      'firstToken',
      'draft',
    ]);
    expect(parseReplyStatsPrefs('0', '{not json', null)).toEqual({ rail: false, hidden: new Set(offByDefault) });
    expect(parseReplyStatsPrefs(null, '["speed"]', null).hidden).toEqual(new Set(offByDefault));
  });
});

describe('the stored prefs', () => {
  it('remember the rail and each stat ticked or unticked across a relaunch', () => {
    setReplyStatsRail(false);
    setReplyStatShown('total', false);
    setReplyStatShown('firstToken', true);
    setReplyStatShown('thinking', false);
    setReplyStatShown('thinking', true);
    reloadReplyStatsPrefs();

    const stored = window.localStorage.getItem('b4m.chat.replyStats.shown');
    expect(JSON.parse(stored ?? 'null')).toEqual({ total: false, firstToken: true });
    expect(parseReplyStatsPrefs(window.localStorage.getItem('b4m.chat.replyStats.rail'), stored, null)).toEqual({
      rail: false,
      hidden: new Set(['total', 'promptSpeed', 'load', 'draft']),
    });
  });

  it('summarise both in one line', () => {
    expect(replyStatsSummary({ rail: true, hidden: new Set() })).toBe(
      'All stats, beside the conversation when the window is wide enough'
    );
    expect(replyStatsSummary({ rail: false, hidden: new Set(['load', 'speed']) })).toBe(
      '9 of 11 stats, under each reply on hover'
    );
    expect(replyStatsSummary(parseReplyStatsPrefs(null, null, null))).toBe(
      '7 of 11 stats, beside the conversation when the window is wide enough'
    );
  });
});
