// @vitest-environment jsdom
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
} from './replyStatsPrefs';

beforeEach(() => {
  window.localStorage.clear();
  reloadReplyStatsPrefs();
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
