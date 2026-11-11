import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { emptyFeedbackTypeCounts, type FeedbackTrends } from './feedbackTrends';

const mocks = vi.hoisted(() => ({ getFeedbackTrendsFromServer: vi.fn() }));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackTrendsFromServer: mocks.getFeedbackTrendsFromServer,
}));
vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { useFeedbackFilters } from './hooks/useFeedbackFilters';
import FeedbackTrendStrip from './FeedbackTrendStrip';

const appTheme = extendTheme({ ...getThemeConfig() });

const daily = Array.from({ length: 30 }, emptyFeedbackTypeCounts);
daily[29][FeedbackType.THUMBS_DOWN] = 3;
daily[29][FeedbackType.BUG] = 1;
daily[10][FeedbackType.FEEDBACK] = 2;

const trends: FeedbackTrends = {
  open: 12,
  receivedLast24h: 4,
  receivedLast30d: 6,
  thumbsDownShare: { current: { thumbsDown: 3, total: 10 }, prior: { thumbsDown: 1, total: 10 } },
  daily,
  asOf: '2026-11-11T12:00:00.000Z',
};

const Harness = () => {
  const { showOnly, filterParams } = useFeedbackFilters();
  return (
    <>
      <FeedbackTrendStrip showOnly={showOnly} />
      <output data-testid="params">{JSON.stringify(filterParams)}</output>
    </>
  );
};

const renderStrip = (mode: 'light' | 'dark' = 'light') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme} defaultMode={mode}>
        <Harness />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const params = () => JSON.parse(screen.getByTestId('params').textContent ?? '{}');

beforeEach(() => {
  mocks.getFeedbackTrendsFromServer.mockReset().mockResolvedValue(trends);
  // Starts narrowed by org and subject, so each figure is seen to clear what it does not count.
  fakeAdminRouter.reset({ tab: 'feedback', feedbackOrg: ['Acme'], feedbackSubject: 'turn', feedbackPage: 3 });
});

describe('FeedbackTrendStrip', () => {
  it.each(['light', 'dark'] as const)('shows every figure in the %s theme', async mode => {
    renderStrip(mode);

    await screen.findByTestId('feedback-trends-sparkline');
    expect(screen.getByTestId('feedback-trends-open')).toHaveTextContent('12');
    expect(screen.getByTestId('feedback-trends-received-24h')).toHaveTextContent('4');
    expect(screen.getByTestId('feedback-trends-thumbs-down')).toHaveTextContent('30%');
    expect(screen.getByTestId('feedback-trends-thumbs-down')).toHaveTextContent('10% the 7 days before, +20 pts');
    expect(screen.getByTestId('feedback-trends-received-30d')).toHaveTextContent('6');
    expect(screen.getByTestId(`feedback-trends-type-${FeedbackType.THUMBS_DOWN}`)).toHaveTextContent('Thumbs down 3');
    expect(screen.getByTestId('feedback-trends-sparkline')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Thumbs down 3')
    );
    expect(screen.getByTestId('feedback-trends-open-btn')).toHaveAttribute('aria-label', 'Show open reports (12)');
    expect(screen.getByTestId('feedback-trends-thumbs-down-btn')).toHaveAttribute(
      'aria-label',
      'Show thumbs-down reports from the last 7 days (30%)'
    );
    expect(screen.queryByTestId('feedback-trends-type-other')).not.toBeInTheDocument();
  });

  it('names the reports with an unknown legacy type that no legend entry counts', async () => {
    mocks.getFeedbackTrendsFromServer.mockResolvedValue({ ...trends, receivedLast30d: 8 });
    renderStrip();

    expect(await screen.findByTestId('feedback-trends-type-other')).toHaveTextContent('Other type 2');
  });

  it('Open shows New and In progress at any age, other filters cleared', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('feedback-trends-open-btn'));

    expect(params()).toEqual({ status: [FeedbackStatus.New, FeedbackStatus.InProgress], sort: 'desc' });
    // Refetched so the figure and the list it opens are counted at nearly the same moment.
    await waitFor(() => expect(mocks.getFeedbackTrendsFromServer).toHaveBeenCalledTimes(2));
    expect(fakeAdminRouter.search).not.toHaveProperty('feedbackPage');
  });

  it('Received, last 24 hours shows every status received in the last day', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('feedback-trends-received-24h-btn'));

    expect(params()).toEqual({ status: Object.values(FeedbackStatus), received: '24h', sort: 'desc' });
    expect(fakeAdminRouter.search).toMatchObject({ feedbackReceived: '24h' });
  });

  it('the thumbs-down share shows thumbs-downs from the last 7 days', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('feedback-trends-thumbs-down-btn'));

    expect(params()).toEqual({
      status: Object.values(FeedbackStatus),
      type: [FeedbackType.THUMBS_DOWN],
      received: '7d',
      sort: 'desc',
    });
  });

  it('the 30-day total and each type apply the 30-day window', async () => {
    renderStrip();
    fireEvent.click(await screen.findByTestId('feedback-trends-received-30d'));
    expect(params()).toEqual({ status: Object.values(FeedbackStatus), received: '30d', sort: 'desc' });

    fireEvent.click(screen.getByTestId(`feedback-trends-type-${FeedbackType.BUG}`));
    expect(params()).toEqual({
      status: Object.values(FeedbackStatus),
      type: [FeedbackType.BUG],
      received: '30d',
      sort: 'desc',
    });
  });

  it('says so when the trends do not load', async () => {
    mocks.getFeedbackTrendsFromServer.mockRejectedValue(new Error('boom'));
    renderStrip();

    expect(await screen.findByTestId('feedback-trends-error')).toBeInTheDocument();
  });
});
