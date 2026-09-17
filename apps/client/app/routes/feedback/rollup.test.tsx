import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { FeedbackRollupResponse } from '@bike4mind/common';

const search = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };
vi.mock('@client/app/router', () => ({
  feedbackRollupRoute: { useSearch: () => search },
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  getAxiosErrorStatus: (error: unknown) => (error as { response?: { status?: number } } | undefined)?.response?.status,
}));

const useFeedbackRollup = vi.fn();
vi.mock('@client/app/hooks/data/feedback', () => ({
  useFeedbackRollup: (...args: unknown[]) => useFeedbackRollup(...args),
}));

import FeedbackRollupPage from './rollup';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const dimension = (buckets: Array<{ key: string; count: number }>, truncated = false) => ({ buckets, truncated });

const payload = (overrides: Partial<FeedbackRollupResponse> = {}): FeedbackRollupResponse => ({
  from: search.from,
  to: search.to,
  total: 0,
  topN: 25,
  textRetentionDays: 90,
  textAvailability: { stored: 0, expired: 0 },
  buckets: {
    sessionId: dimension([]),
    questId: dimension([]),
    subject: dimension([]),
    status: dimension([]),
    tags: dimension([]),
  },
  ...overrides,
});

const succeed = (data: FeedbackRollupResponse) =>
  useFeedbackRollup.mockReturnValue({ data, isPending: false, isError: false, error: null });

const renderPage = () => render(<FeedbackRollupPage />, { wrapper: TestWrapper });

beforeEach(() => {
  useFeedbackRollup.mockReset();
});

describe('FeedbackRollupPage', () => {
  it('passes the route-resolved window straight through, computing no dates of its own', () => {
    succeed(payload());
    renderPage();

    expect(useFeedbackRollup).toHaveBeenCalledWith(search);
  });

  it('says the window is empty rather than showing five empty tables', () => {
    succeed(payload());
    renderPage();

    expect(screen.getByTestId('rollup-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('rollup-subject-card')).not.toBeInTheDocument();
  });

  /**
   * The owner-scoping proof for the UI: the page is handed the shape the real endpoint returns for
   * one user and must put that user's keys on screen and nobody else's. A fetch-level assertion
   * would not catch a renderer that read the wrong dimension.
   */
  it('renders exactly the keys the response carried, with the full id recoverable', () => {
    const mine = ['68b1f0a2c4e5d6f701234561', '68b1f0a2c4e5d6f701234562'];
    const notMine = '68b1f0a2c4e5d6f7019999ff';
    succeed(
      payload({
        total: 3,
        buckets: {
          sessionId: dimension([
            { key: mine[0], count: 2 },
            { key: mine[1], count: 1 },
          ]),
          questId: dimension([]),
          subject: dimension([{ key: 'turn', count: 3 }]),
          status: dimension([{ key: 'new', count: 3 }]),
          tags: dimension([{ key: 'retrieval', count: 1 }]),
        },
      })
    );
    renderPage();

    const rendered = screen
      .getAllByTestId('rollup-sessionId-row')
      .map(row => row.querySelector('[title]')?.getAttribute('title'));
    expect(rendered).toEqual(mine);
    expect(screen.queryByTitle(notMine)).not.toBeInTheDocument();
    // Shortened for readability, but the full id is what the title carries.
    expect(screen.getByText('...234561')).toBeInTheDocument();
    expect(screen.getByText('retrieval')).toBeInTheDocument();
  });

  it('names the retention cutoff only when reports in the window have actually lost their text', () => {
    succeed(payload({ total: 4, textAvailability: { stored: 1, expired: 3 } }));
    const { unmount } = renderPage();

    expect(screen.getByTestId('rollup-retention-notice')).toHaveTextContent('3 of these reports');
    expect(screen.getByTestId('rollup-retention-notice')).toHaveTextContent('90-day');
    unmount();

    succeed(payload({ total: 4, textAvailability: { stored: 4, expired: 0 } }));
    renderPage();
    expect(screen.queryByTestId('rollup-retention-notice')).not.toBeInTheDocument();
  });

  it('says a dimension is capped when the server truncated it', () => {
    succeed(
      payload({
        total: 40,
        buckets: {
          sessionId: dimension([{ key: '68b1f0a2c4e5d6f701234561', count: 40 }], true),
          questId: dimension([]),
          subject: dimension([{ key: 'turn', count: 40 }]),
          status: dimension([]),
          tags: dimension([]),
        },
      })
    );
    renderPage();

    expect(screen.getByTestId('rollup-sessionId-truncated')).toHaveTextContent('top 25');
    expect(screen.queryByTestId('rollup-subject-truncated')).not.toBeInTheDocument();
  });

  it('reads a rejected window off the 422 this app actually returns, not a 400', () => {
    useFeedbackRollup.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { response: { status: 422 } },
    });
    renderPage();

    expect(screen.getByTestId('rollup-error-alert')).toHaveTextContent('date range is not valid');
  });

  it('falls back to a generic failure for any other error status', () => {
    useFeedbackRollup.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { response: { status: 500 } },
    });
    renderPage();

    expect(screen.getByTestId('rollup-error-alert')).toHaveTextContent('could not load your feedback counts');
  });

  it('shows a spinner while the first read is in flight', () => {
    useFeedbackRollup.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null });
    renderPage();

    expect(screen.getByTestId('rollup-loading-indicator')).toBeInTheDocument();
  });
});
