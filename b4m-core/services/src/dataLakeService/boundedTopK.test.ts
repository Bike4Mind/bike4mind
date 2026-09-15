import { describe, it, expect } from 'vitest';
import { BoundedTopK } from './boundedTopK';

/** Descending by value, with an id tiebreaker so the order is total. */
const byValue = (a: { id: string; v: number }, b: { id: string; v: number }) =>
  b.v - a.v || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const collect = (capacity: number, items: { id: string; v: number }[]) => {
  const topK = new BoundedTopK(capacity, byValue);
  items.forEach(i => topK.offer(i));
  return topK.drain().map(i => i.id);
};

describe('BoundedTopK', () => {
  it('keeps the best N and never grows past the capacity', () => {
    const topK = new BoundedTopK(3, byValue);
    for (let v = 0; v < 100; v++) topK.offer({ id: `i${v}`, v });
    expect(topK.size).toBe(3);
    expect(topK.drain().map(i => i.v)).toEqual([99, 98, 97]);
  });

  it('returns best-first regardless of the order items are offered in', () => {
    const items = [
      { id: 'a', v: 5 },
      { id: 'b', v: 1 },
      { id: 'c', v: 9 },
      { id: 'd', v: 3 },
    ];
    expect(collect(4, items)).toEqual(['c', 'a', 'd', 'b']);
    expect(collect(4, [...items].reverse())).toEqual(['c', 'a', 'd', 'b']);
  });

  it('an item worse than the current worst is rejected once full', () => {
    const topK = new BoundedTopK(2, byValue);
    topK.offer({ id: 'a', v: 10 });
    topK.offer({ id: 'b', v: 9 });
    topK.offer({ id: 'c', v: 1 });
    expect(topK.drain().map(i => i.id)).toEqual(['a', 'b']);
  });

  it('an item better than the current worst displaces it', () => {
    const topK = new BoundedTopK(2, byValue);
    topK.offer({ id: 'a', v: 10 });
    topK.offer({ id: 'b', v: 1 });
    topK.offer({ id: 'c', v: 5 });
    expect(topK.drain().map(i => i.id)).toEqual(['a', 'c']);
  });

  it('breaks ties by the comparator, not by arrival order', () => {
    // The property the streaming ranker depends on: pages arrive in an order the caller does
    // not control, so a tie must resolve the same way whichever page brought the item.
    const tied = [
      { id: 'z', v: 1 },
      { id: 'a', v: 1 },
      { id: 'm', v: 1 },
    ];
    expect(collect(2, tied)).toEqual(['a', 'm']);
    expect(collect(2, [...tied].reverse())).toEqual(['a', 'm']);
  });

  it('fewer items than the capacity returns them all, still ordered', () => {
    expect(
      collect(10, [
        { id: 'a', v: 1 },
        { id: 'b', v: 7 },
      ])
    ).toEqual(['b', 'a']);
  });

  it('a capacity of zero collects nothing', () => {
    // Mirrors the old slice(0, 0) behaviour for topK: 0.
    expect(collect(0, [{ id: 'a', v: 1 }])).toEqual([]);
  });

  it('a capacity of one keeps only the single best', () => {
    expect(
      collect(1, [
        { id: 'a', v: 1 },
        { id: 'b', v: 7 },
        { id: 'c', v: 3 },
      ])
    ).toEqual(['b']);
  });

  it('an empty collector drains to an empty array', () => {
    expect(new BoundedTopK(5, byValue).drain()).toEqual([]);
  });
});
