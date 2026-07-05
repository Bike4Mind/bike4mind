import { describe, it, expect } from 'vitest';
import { compareDateGroupKeys, groupItemsByDate } from './dateGrouping';

describe('compareDateGroupKeys', () => {
  it('orders the special relative-date labels Today → Yesterday → Previous 7 → Previous 30', () => {
    const keys = ['Previous 30 Days', 'Today', 'Previous 7 Days', 'Yesterday'];
    expect([...keys].sort(compareDateGroupKeys)).toEqual(['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days']);
  });

  it('places special relative-date labels before month labels', () => {
    expect(['March', 'Today'].sort(compareDateGroupKeys)).toEqual(['Today', 'March']);
    expect(['January 2023', 'Previous 7 Days'].sort(compareDateGroupKeys)).toEqual(['Previous 7 Days', 'January 2023']);
  });

  it('orders current-year months most-recent-first', () => {
    expect(['January', 'March', 'February'].sort(compareDateGroupKeys)).toEqual(['March', 'February', 'January']);
  });

  it('orders by year first (most recent year first) when both keys carry a year', () => {
    expect(['December 2024', 'January 2025'].sort(compareDateGroupKeys)).toEqual(['January 2025', 'December 2024']);
  });

  it('falls back to alphabetical for non-priority, non-month keys', () => {
    expect(['Zebra', 'Apple'].sort(compareDateGroupKeys)).toEqual(['Apple', 'Zebra']);
  });
});

describe('groupItemsByDate', () => {
  it('groups items under their label and de-duplicates by id, preserving first occurrence', () => {
    const items = [
      { id: 'a', label: 'Today' },
      { id: 'b', label: 'Today' },
      { id: 'a', label: 'Today' }, // duplicate id — must be ignored
      { id: 'c', label: 'March' },
    ];
    const grouped = groupItemsByDate(items, item => item.label);
    expect(grouped).toEqual({
      Today: [
        { id: 'a', label: 'Today' },
        { id: 'b', label: 'Today' },
      ],
      March: [{ id: 'c', label: 'March' }],
    });
  });

  it('returns an empty object for no items', () => {
    expect(groupItemsByDate([], () => 'Today')).toEqual({});
  });
});
