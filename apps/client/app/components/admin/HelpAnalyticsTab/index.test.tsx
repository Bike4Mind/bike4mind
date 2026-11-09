import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { HelpAnalyticsData, HelpAnalyticsFilters } from '@client/app/hooks/data/helpAnalytics';
import { SEARCH_TERM_URL_DEBOUNCE_MS } from '../shared';

const { useHelpAnalyticsData, refetch } = vi.hoisted(() => ({ useHelpAnalyticsData: vi.fn(), refetch: vi.fn() }));

vi.mock('@client/app/hooks/data/helpAnalytics', () => ({ useHelpAnalyticsData }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

import HelpAnalyticsTab from './index';

const theme = extendTheme({ ...getThemeConfig() });

const DATA: HelpAnalyticsData = {
  overview: {
    totalViews: 1200,
    uniqueArticlesViewed: 40,
    totalSearches: 300,
    totalFeedback: 12,
    totalChatQueries: 55,
    totalChatFeedback: 9,
  },
  topArticles: [],
  searchGaps: [{ query: 'billing export', count: 4, lastSearched: '2026-11-01T00:00:00.000Z' }],
  feedbackSummary: [],
  chatTopics: [],
  recentFeedback: [],
  chatFeedback: [
    {
      chatQuestion: 'How do I export a notebook?',
      chatAnswer: 'Open the notebook menu.',
      rating: 'not_helpful',
      comment: 'Too short',
      userId: 'u1',
      createdAt: '2026-11-02T00:00:00.000Z',
    },
  ],
};

const queryResult = (overrides: Record<string, unknown> = {}) => ({
  data: DATA,
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch,
  ...overrides,
});

const renderTab = () =>
  render(
    <CssVarsProvider theme={theme}>
      <HelpAnalyticsTab />
    </CssVarsProvider>
  );

const lastFilters = () => useHelpAnalyticsData.mock.calls.at(-1)?.[0];

/** Every flex-wrap value any style rule (inside a media query too) gives the element. */
function declaredFlexWraps(element: Element): string[] {
  const values: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) visit(rule.cssRules);
      else if (rule instanceof CSSStyleRule && element.matches(rule.selectorText)) {
        const value = rule.style.getPropertyValue('flex-wrap');
        if (value) values.push(value);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
  return values;
}

beforeEach(() => {
  refetch.mockReset();
  useHelpAnalyticsData.mockReset();
  useHelpAnalyticsData.mockReturnValue(queryResult());
});

describe('HelpAnalyticsTab page anatomy', () => {
  it('opens with the page header as the only h1', () => {
    renderTab();
    const header = screen.getByTestId('admin-page-header');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Help analytics');
    expect(header).toHaveTextContent(
      'Help article views, searches and feedback, and questions asked in the help chat.'
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(header.compareDocumentPosition(screen.getByTestId('help-analytics-filter-row'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('shows the totals in one stat strip with no decorative icons', () => {
    renderTab();
    const strip = screen.getByTestId('admin-stat-strip');
    expect(
      within(strip)
        .getAllByTestId('admin-stat-tile')
        .map(tile => tile.textContent)
    ).toEqual([
      'Total views1,200',
      'Unique articles40',
      'Total searches300',
      'Article feedback12',
      'Chat queries55',
      'Chat feedback9',
    ]);
    expect(strip.querySelector('svg')).toBeNull();
  });

  it('keeps the tab strip on one line at every width', () => {
    renderTab();
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveStyle({ flexWrap: 'nowrap', overflowX: 'auto' });
    expect(declaredFlexWraps(tablist)).toContain('nowrap');
    expect(declaredFlexWraps(tablist)).not.toContain('wrap');
    expect(within(tablist).getByRole('tab', { name: 'Popular articles' })).toHaveStyle({ whiteSpace: 'nowrap' });
  });
});

describe('HelpAnalyticsTab date range', () => {
  it('puts the range in one wrapping row and applies a preset when it is picked', async () => {
    renderTab();
    const row = screen.getByTestId('help-analytics-filter-row');
    expect(row).toHaveStyle({ flexWrap: 'wrap' });
    expect(within(row).getByTestId('help-analytics-range-week')).toHaveAttribute('aria-pressed', 'true');
    const segments = within(within(row).getByTestId('help-analytics-range')).getAllByRole('button');
    expect(segments.map(segment => segment.textContent)).toEqual(['Last week', 'Last month', 'Last year', 'All time']);
    expect(within(row).getByTestId('admin-filter-help-range')).toHaveTextContent('Range');
    expect(screen.queryByTestId('help-analytics-date-from')).toBeNull();

    fireEvent.click(within(row).getByTestId('help-analytics-range-all'));
    await waitFor(() => expect(lastFilters()).toEqual({}));
  });

  it('applies typed custom days once typing settles, not on every keystroke', () => {
    vi.useFakeTimers();
    try {
      renderTab();
      fireEvent.click(screen.getByTestId('admin-filter-help-range'));
      fireEvent.click(screen.getByTestId('admin-filter-help-range-custom'));
      expect(screen.getByTestId('help-analytics-range-week')).toHaveAttribute('aria-pressed', 'false');
      fireEvent.change(screen.getByTestId('help-analytics-date-from'), { target: { value: '2026-10-01' } });
      fireEvent.change(screen.getByTestId('help-analytics-date-to'), { target: { value: '2026-10-31' } });
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS - 1));
      expect(lastFilters()).not.toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
      act(() => vi.advanceTimersByTime(1));
      expect(lastFilters()).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a From later than To as an ordered range', () => {
    vi.useFakeTimers();
    try {
      renderTab();
      fireEvent.click(screen.getByTestId('admin-filter-help-range'));
      fireEvent.click(screen.getByTestId('admin-filter-help-range-custom'));
      fireEvent.change(screen.getByTestId('help-analytics-date-from'), { target: { value: '2026-10-31' } });
      fireEvent.change(screen.getByTestId('help-analytics-date-to'), { target: { value: '2026-10-01' } });
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS));
      expect(lastFilters()).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
      expect(screen.getByTestId('help-analytics-date-from')).toHaveValue('2026-10-31');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the totals and tables on screen under an updating bar while a new range loads', async () => {
    useHelpAnalyticsData.mockImplementation((filters?: HelpAnalyticsFilters) =>
      // What placeholder data gives: the previous numbers stay while the new range is fetched.
      queryResult(filters?.dateFrom ? {} : { isFetching: true })
    );
    renderTab();
    expect(screen.getByTestId('admin-stat-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('help-analytics-updating')).toBeNull();
    fireEvent.click(screen.getByTestId('help-analytics-range-all'));
    const bar = await screen.findByTestId('help-analytics-updating');
    expect(bar).toBeVisible();
    expect(bar.compareDocumentPosition(screen.getByTestId('admin-stat-strip'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole('tab', { name: 'Popular articles' })).toBeInTheDocument();
    expect(screen.queryByTestId('admin-loading-state')).toBeNull();
  });
});

describe('HelpAnalyticsTab tables and states', () => {
  it('lists rows in a DataTable', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('help-analytics-tab-search-gaps'));
    const table = screen.getByTestId('help-analytics-search-gaps-table');
    expect(within(table).getByRole('columnheader', { name: 'Count' })).toBeInTheDocument();
    expect(table).toHaveTextContent('billing export');
  });

  it('shows an empty state that clears the date range when a table is empty', async () => {
    renderTab();
    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No article views');
    fireEvent.click(within(empty).getByTestId('help-analytics-clear-range-btn'));
    expect(screen.getByTestId('help-analytics-range-all')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastFilters()).toEqual({}));
  });

  it('offers a refresh from the empty state once the range is already all time', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('help-analytics-range-all'));
    fireEvent.click(within(screen.getByTestId('admin-empty-state')).getByTestId('help-analytics-empty-refresh-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state on first load and an error state with a retry when it fails', () => {
    useHelpAnalyticsData.mockReturnValue(queryResult({ data: undefined, isLoading: true }));
    const { unmount } = renderTab();
    expect(screen.getByTestId('admin-loading-state')).toHaveTextContent('Loading help analytics');
    unmount();

    useHelpAnalyticsData.mockReturnValue(queryResult({ data: undefined, isError: true }));
    renderTab();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Help analytics failed to load.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the error state above the stale totals when a refetch fails', () => {
    useHelpAnalyticsData.mockReturnValue(queryResult({ isError: true }));
    renderTab();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Help analytics failed to load.');
    expect(screen.getByText('Total views')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('opens a chat answer in a dialog with its rating', async () => {
    renderTab();
    fireEvent.click(screen.getByTestId('help-analytics-tab-chat-feedback'));
    fireEvent.click(screen.getByTestId('chat-feedback-view-btn'));
    const dialog = await screen.findByTestId('help-analytics-chat-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Chat feedback');
    expect(within(dialog).getByTestId('markdown')).toHaveTextContent('Open the notebook menu.');
    expect(within(dialog).getByTestId('admin-status-chip')).toHaveTextContent('Bad');
    fireEvent.click(within(dialog).getByTestId('help-analytics-chat-dialog-close-btn'));
    await waitFor(() => expect(screen.queryByTestId('help-analytics-chat-dialog')).toBeNull());
  });
});
