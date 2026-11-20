import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useHelpAnalyticsData, type HelpAnalyticsData } from './helpAnalytics';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

const analytics = (totalViews: number): HelpAnalyticsData => ({
  topArticles: [],
  searchGaps: [],
  feedbackSummary: [],
  chatTopics: [],
  overview: {
    totalViews,
    totalSearches: 0,
    totalFeedback: 0,
    totalChatQueries: 0,
    uniqueArticlesViewed: 0,
    totalChatFeedback: 0,
  },
  recentFeedback: [],
  chatFeedback: [],
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children
  );

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe('useHelpAnalyticsData range changes', () => {
  it('keeps the previous analytics while a new date range loads', async () => {
    let resolveNewRange: ((value: { data: HelpAnalyticsData }) => void) | undefined;
    vi.mocked(api.get).mockImplementation((url: string) =>
      url.includes('dateFrom=2026-10-15')
        ? new Promise(resolve => {
            resolveNewRange = resolve;
          })
        : Promise.resolve({ data: analytics(10) })
    );
    const { result, rerender } = renderHook(({ filters }) => useHelpAnalyticsData(filters), {
      wrapper,
      initialProps: { filters: { dateFrom: '2026-10-14' } },
    });
    await waitFor(() => expect(result.current.data?.overview.totalViews).toBe(10));

    rerender({ filters: { dateFrom: '2026-10-15' } });
    await waitFor(() => expect(resolveNewRange).toBeDefined());
    expect(result.current.data?.overview.totalViews).toBe(10);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => {
      resolveNewRange?.({ data: analytics(25) });
    });
    await waitFor(() => expect(result.current.data?.overview.totalViews).toBe(25));
    expect(result.current.isPlaceholderData).toBe(false);
  });
});
