import { describe, it, expect, vi } from 'vitest';
import { collectUserActivityRows, EXPORT_PAGE_SIZE, MAX_EXPORT_ROWS } from './exportUserActivity';

/**
 * The grid now holds one page, so "Export CSV" has to walk the pages itself. It must stay
 * bounded: the unbounded single response is exactly what tripped Lambda's 6MB cap.
 */
const rows = (n: number, page = 0) =>
  Array.from({ length: n }, (_, i) => ({ date: '2026-07-28', counterName: `c${page}-${i}`, count: 1, totalValue: 1 }));

describe('collectUserActivityRows', () => {
  it('exports every matching row, not just the page on screen', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ logs: page === 1 ? rows(10, 1) : rows(4, 2), total: 14 }));

    const result = await collectUserActivityRows(fetchPage, { pageSize: 10 });

    expect(result.rows).toHaveLength(14);
    expect(result.truncated).toBe(false);
  });

  it('stops once the server returns a short page', async () => {
    const fetchPage = vi.fn(async () => ({ logs: rows(3), total: 3 }));

    await collectUserActivityRows(fetchPage, { pageSize: 10 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps the pages in order', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ logs: page === 1 ? rows(2, 1) : rows(1, 2), total: 3 }));

    const result = await collectUserActivityRows(fetchPage, { pageSize: 2 });

    expect(result.rows.map(r => r.counterName)).toEqual(['c1-0', 'c1-1', 'c2-0']);
  });

  it('caps a runaway export and flags it as truncated', async () => {
    // A server that always returns a full page would page forever without the cap.
    const fetchPage = vi.fn(async () => ({ logs: rows(10), total: 10_000 }));

    const result = await collectUserActivityRows(fetchPage, { pageSize: 10, maxRows: 25 });

    expect(result.rows).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('holds the page size constant so the server skips to the right offset', async () => {
    // The server derives $skip from (page - 1) * limit. Shrinking the last request to land
    // exactly on maxRows would move that window: with pageSize 100 and maxRows 250, a final
    // limit of 50 makes the server skip 100 - re-sending rows 101-150 and losing 201-250.
    const fetchPage = vi.fn(async () => ({ logs: rows(100), total: 1000 }));

    const result = await collectUserActivityRows(fetchPage, { pageSize: 100, maxRows: 250 });

    expect(fetchPage.mock.calls.map(([, limit]) => limit)).toEqual([100, 100, 100]);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    expect(result.rows).toHaveLength(250);
  });

  it('reports progress so a long export can show where it is', async () => {
    const onProgress = vi.fn();
    const fetchPage = vi.fn(async (page: number) => ({ logs: page === 1 ? rows(2) : rows(1), total: 3 }));

    await collectUserActivityRows(fetchPage, { pageSize: 2, onProgress });

    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });

  it('defaults to a page size and cap that keep each request under the response limit', () => {
    expect(EXPORT_PAGE_SIZE).toBeLessThanOrEqual(5000);
    expect(MAX_EXPORT_ROWS).toBeGreaterThan(EXPORT_PAGE_SIZE);
  });
});
