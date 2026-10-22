import { describe, expect, it } from 'vitest';
import { collapseApiItems, isApiOriginItem } from './apiGrouping';

const web = (id: string) => ({ id, origin: { channel: 'web' } });
const api = (id: string) => ({ id, origin: { channel: 'api' } });
const legacy = (id: string) => ({ id });

const shape = (rows: ReturnType<typeof collapseApiItems<{ id: string }>>) =>
  rows.map(row => (row.kind === 'item' ? row.item.id : `group(${row.items.map(i => i.id).join(',')})`));

describe('isApiOriginItem', () => {
  it('matches only the api channel', () => {
    expect(isApiOriginItem(api('a'))).toBe(true);
    expect(isApiOriginItem(web('w'))).toBe(false);
    expect(isApiOriginItem(legacy('l'))).toBe(false);
    expect(isApiOriginItem({ id: 'p', isProject: true })).toBe(false);
    expect(isApiOriginItem(null)).toBe(false);
  });
});

describe('collapseApiItems', () => {
  it('folds non-consecutive API items into one group at the first API position', () => {
    const rows = collapseApiItems([web('w1'), api('a1'), legacy('l1'), api('a2'), web('w2')], 'Today');
    expect(shape(rows)).toEqual(['w1', 'group(a1,a2)', 'l1', 'w2']);
  });

  it('keys the group by bucket so expansion can be remembered per bucket', () => {
    const rows = collapseApiItems([api('a1'), api('a2')], 'Yesterday');
    expect(rows).toEqual([{ kind: 'apiGroup', key: 'Yesterday', items: [api('a1'), api('a2')] }]);
  });

  it('leaves a single API item as a plain row', () => {
    expect(shape(collapseApiItems([web('w1'), api('a1')], 'Today'))).toEqual(['w1', 'a1']);
  });

  it('leaves a bucket without API items untouched', () => {
    expect(shape(collapseApiItems([web('w1'), legacy('l1')], 'Today'))).toEqual(['w1', 'l1']);
    expect(collapseApiItems([], 'Today')).toEqual([]);
  });

  it('accepts a custom predicate', () => {
    const rows = collapseApiItems([{ id: 'x' }, { id: 'y' }], 'Today', () => true);
    expect(shape(rows)).toEqual(['group(x,y)']);
  });
});
