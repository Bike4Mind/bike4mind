import type { ChatSessionSummary } from '@shared/chat';
import { afterEach, describe, expect, it } from 'vitest';
import { capRows, GROUP_ROW_CAP, GROUP_ROW_STEP, groupLimit, setGroupLimit } from './groupCap';
import { QUICK_SWITCH_LIMIT } from './grouping';

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `s${index}`, title: `S${index}` }) as ChatSessionSummary);
const none = () => false;

describe('capRows', () => {
  it('draws a group of exactly the cap whole', () => {
    const capped = capRows(rows(GROUP_ROW_CAP), GROUP_ROW_CAP, none);
    expect(capped.visible).toHaveLength(GROUP_ROW_CAP);
    expect(capped.hidden).toBe(0);
  });

  it('hides the one row past the cap', () => {
    const capped = capRows(rows(21), GROUP_ROW_CAP, none);
    expect(capped.visible.map(row => row.id)).toEqual(rows(20).map(row => row.id));
    expect(capped.hidden).toBe(1);
    expect(capped.nextLimit).toBe(21);
  });

  it('steps a long group ten at a time', () => {
    const sessions = rows(500);
    const capped = capRows(sessions, GROUP_ROW_CAP, none);
    expect(capped.visible).toHaveLength(20);
    expect(capped.hidden).toBe(480);
    expect(capped.nextLimit).toBe(20 + GROUP_ROW_STEP);
  });

  it('draws a kept row past the limit in its own place, counted as visible', () => {
    const sessions = rows(500);
    const capped = capRows(sessions, GROUP_ROW_CAP, session => session.id === 's300' || session.id === 's25');
    expect(capped.visible).toHaveLength(22);
    expect(capped.visible.slice(-2).map(row => row.id)).toEqual(['s25', 's300']);
    expect(capped.hidden).toBe(478);
    // The kept s25 sits inside the next ten, so reaching ten newly drawn rows goes one further.
    expect(capped.nextLimit).toBe(31);
  });

  it('hides nothing when every row past the limit is kept', () => {
    const capped = capRows(rows(30), GROUP_ROW_CAP, () => true);
    expect(capped.visible).toHaveLength(30);
    expect(capped.hidden).toBe(0);
  });
});

describe('group limits', () => {
  afterEach(() => setGroupLimit('project:/a', GROUP_ROW_CAP));

  it('start at the cap, and going back to it forgets the group', () => {
    expect(groupLimit('project:/a')).toBe(GROUP_ROW_CAP);
    setGroupLimit('project:/a', 40);
    expect(groupLimit('project:/a')).toBe(40);
    expect(groupLimit('project:/b')).toBe(GROUP_ROW_CAP);
    setGroupLimit('project:/a', GROUP_ROW_CAP);
    expect(groupLimit('project:/a')).toBe(GROUP_ROW_CAP);
  });

  it('never hide a row the quick-switch shortcut can reach', () => {
    expect(GROUP_ROW_CAP).toBeGreaterThanOrEqual(QUICK_SWITCH_LIMIT);
  });
});
