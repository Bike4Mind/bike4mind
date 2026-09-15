// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackStatus } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { FEEDBACK_LIST_MAX_LIMIT } from '@bike4mind/common';
import { getAllFeedbackForExport, FEEDBACK_EXPORT_MAX_ROWS } from './feedbackAPICalls';

const rows = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({
    _id: `fb-${offset + i}`,
    status: FeedbackStatus.New,
    content: 'x',
  }));

/** One page of the list envelope, as GET /api/feedback returns it. */
const page = (items: unknown[], total: number) => ({ data: { items, total, page: 1, limit: 100, organizations: [] } });

describe('getAllFeedbackForExport', () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  /**
   * The export must cover every row matching the filters, not the page on screen. Before this
   * existed the CSV carried whatever the current page held, which reads as a complete export of
   * a suspiciously small data set.
   */
  it('pages through every match rather than exporting one page', async () => {
    mocks.get
      .mockResolvedValueOnce(page(rows(100), 250))
      .mockResolvedValueOnce(page(rows(100, 100), 250))
      .mockResolvedValueOnce(page(rows(50, 200), 250));

    const { items, truncated } = await getAllFeedbackForExport({ sort: 'desc' });

    expect(items).toHaveLength(250);
    expect(truncated).toBe(false);
    expect(mocks.get).toHaveBeenCalledTimes(3);
    expect(mocks.get.mock.calls.map(([, config]) => config.params.page)).toEqual([1, 2, 3]);
  });

  it('requests the largest page the server will accept', async () => {
    mocks.get.mockResolvedValue(page(rows(1), 1));

    await getAllFeedbackForExport({ sort: 'desc' });

    expect(mocks.get.mock.calls[0][1].params.limit).toBe(FEEDBACK_LIST_MAX_LIMIT);
  });

  it('forwards the active filters to every page', async () => {
    mocks.get.mockResolvedValueOnce(page(rows(100), 150)).mockResolvedValueOnce(page(rows(50, 100), 150));

    await getAllFeedbackForExport({ sort: 'asc', status: [FeedbackStatus.Closed], search: 'crash' });

    for (const [, config] of mocks.get.mock.calls) {
      expect(config.params).toMatchObject({ sort: 'asc', status: [FeedbackStatus.Closed], search: 'crash' });
    }
  });

  /**
   * Load-bearing: past the cap the caller has to be told the file is short. A silent slice is the
   * failure mode this flag exists for - the reader cannot tell a truncated export from a complete
   * one by looking at it.
   */
  it('reports truncation when the match set exceeds the row cap', async () => {
    const total = FEEDBACK_EXPORT_MAX_ROWS + 500;
    mocks.get.mockResolvedValue(page(rows(100), total));

    const { items, truncated } = await getAllFeedbackForExport({ sort: 'desc' });

    expect(truncated).toBe(true);
    expect(items).toHaveLength(FEEDBACK_EXPORT_MAX_ROWS);
  });

  // An empty page with a total the rows never reach would otherwise page forever.
  it('stops on an empty page even when total disagrees', async () => {
    mocks.get.mockResolvedValueOnce(page(rows(100), 999999)).mockResolvedValueOnce(page([], 999999));

    const { items, truncated } = await getAllFeedbackForExport({ sort: 'desc' });

    expect(items).toHaveLength(100);
    expect(truncated).toBe(false);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('returns nothing for a filter that matches nothing', async () => {
    mocks.get.mockResolvedValue(page([], 0));

    const { items, truncated } = await getAllFeedbackForExport({ sort: 'desc' });

    expect(items).toEqual([]);
    expect(truncated).toBe(false);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
