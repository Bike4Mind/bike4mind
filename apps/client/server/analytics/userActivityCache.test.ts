import { describe, it, expect } from 'vitest';
import {
  asWindow,
  buildWindow,
  sliceWindow,
  windowCoversPage,
  windowRowsFor,
  CACHE_WINDOW_PAGES,
  MAX_CACHED_ROWS,
} from './userActivityCache';

const makeWindow = (rowCount: number, total = rowCount, truncated = false) => ({
  rows: Array.from({ length: rowCount }, (_, i) => ({ i })),
  total,
  truncated,
});

describe('windowRowsFor', () => {
  it('reads ahead of the requested page so later pages need no second aggregation', () => {
    expect(windowRowsFor(0, 25)).toBe(25 * CACHE_WINDOW_PAGES);
  });

  it('widens the window to reach a page beyond the read-ahead', () => {
    const skip = 25 * CACHE_WINDOW_PAGES * 2;

    expect(windowRowsFor(skip, 25)).toBe(skip + 25);
  });

  it('never shrinks a window a later page already paid for', () => {
    // Without the floor, alternating between page 1 and a far page re-aggregates every time.
    expect(windowRowsFor(0, 25, 4000)).toBe(4000);
  });

  it('caps the window at the row ceiling', () => {
    expect(windowRowsFor(0, MAX_CACHED_ROWS)).toBe(MAX_CACHED_ROWS);
  });

  it('refuses to window a page past the ceiling, so it is fetched on its own', () => {
    expect(windowRowsFor(MAX_CACHED_ROWS, 25)).toBeNull();
  });

  it('spans a whole CSV export in one window at the export page size', () => {
    // The export walks pages of 5000 up to 50000 rows; every one of them must land in the window
    // or the tail pages each pay for their own aggregation again.
    expect(windowRowsFor(0, 5000)).toBe(MAX_CACHED_ROWS);
    expect(windowRowsFor(45_000, 5000)).toBe(MAX_CACHED_ROWS);
  });
});

describe('windowCoversPage', () => {
  it('covers a page inside the cached prefix', () => {
    expect(windowCoversPage(makeWindow(100, 900), 50, 25)).toBe(true);
  });

  it('does not cover a page past the cached prefix of a larger result set', () => {
    expect(windowCoversPage(makeWindow(100, 900), 100, 25)).toBe(false);
  });

  it('covers a page past the end of a fully cached result set', () => {
    // The empty slice is the right answer here, not a reason to re-run the aggregation.
    expect(windowCoversPage(makeWindow(5), 100, 25)).toBe(true);
  });

  it('covers an empty result set', () => {
    expect(windowCoversPage(makeWindow(0), 0, 25)).toBe(true);
  });
});

describe('sliceWindow', () => {
  it('returns the requested page', () => {
    expect(sliceWindow(makeWindow(100), 50, 3)).toEqual([{ i: 50 }, { i: 51 }, { i: 52 }]);
  });
});

describe('buildWindow', () => {
  it('keeps the whole window when it fits the budget', () => {
    const entry = buildWindow([{ a: 1 }, { a: 2 }], 2);

    expect(entry).toEqual({ rows: [{ a: 1 }, { a: 2 }], total: 2, truncated: false });
  });

  it('trims to the longest prefix inside the budget and flags it', () => {
    // The entry is one Mongo document, and an untrimmed window is what blew past the 16MB BSON
    // limit before paging existed - a write that throws leaves the route uncached forever.
    const rows = Array.from({ length: 10 }, (_, i) => ({ pad: 'x'.repeat(100), i }));

    const entry = buildWindow(rows, 10, 400);

    expect(entry.truncated).toBe(true);
    expect(entry.rows.length).toBeGreaterThan(0);
    expect(entry.rows.length).toBeLessThan(rows.length);
    expect(entry.total, 'the total counts every matching row, not the cached ones').toBe(10);
  });

  it('measures UTF-8 bytes rather than characters', () => {
    // A 3-byte-per-character metadata value must not be sized as if it were ASCII.
    const rows = [{ v: '\u4e2d'.repeat(20) }];

    expect(buildWindow(rows, 1, 40).truncated).toBe(true);
  });
});

describe('asWindow', () => {
  it('narrows a stored window', () => {
    expect(asWindow({ rows: [{ a: 1 }], total: 9, truncated: true })).toEqual({
      rows: [{ a: 1 }],
      total: 9,
      truncated: true,
    });
  });

  it('defaults a missing truncated flag rather than treating the entry as unusable', () => {
    expect(asWindow({ rows: [], total: 0 })?.truncated).toBe(false);
  });

  it.each([null, undefined, 'nope', {}, { rows: [] }, { rows: 'no', total: 1 }])(
    'rejects the non-window cache payload %j',
    (payload: unknown) => {
      expect(asWindow(payload)).toBeNull();
    }
  );
});
