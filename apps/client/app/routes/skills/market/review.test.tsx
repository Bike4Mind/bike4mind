// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  me: { isReviewer: false, isAdmin: false, organizations: [] as unknown[] },
  reports: [] as unknown[],
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMarketMe: () => ({ data: h.me, isLoading: false }),
  useReviewQueue: (filter: string) => ({
    data: filter === 'reports' ? h.reports : [],
    isLoading: false,
    isError: false,
  }),
  useReviewVersion: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useModerateListing: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import ReviewQueuePage from './review';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ReviewQueuePage />
    </CssVarsProvider>
  );

describe('ReviewQueuePage access', () => {
  beforeEach(() => {
    h.me = { isReviewer: false, isAdmin: false, organizations: [] };
    h.reports = [];
  });

  it('shows the no-access state to a non-reviewer', () => {
    renderPage();
    expect(screen.getByText('Reviewers only')).toBeInTheDocument();
    expect(screen.queryByTestId('market-review-page')).toBeNull();
  });

  it('hides the Legacy tab from a reviewer who is not an admin', () => {
    h.me = { isReviewer: true, isAdmin: false, organizations: [] };
    renderPage();
    expect(screen.getByTestId('market-review-tab-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('market-review-tab-legacy')).toBeNull();
  });

  it('shows the Legacy tab to an admin', () => {
    h.me = { isReviewer: true, isAdmin: true, organizations: [] };
    renderPage();
    expect(screen.getByTestId('market-review-tab-legacy')).toBeInTheDocument();
  });
});

describe('ReviewQueuePage reports tab', () => {
  const item = (name: string, count: number, countingCount: number) => ({
    listing: { id: `id-${name}`, name, description: 'd', hiddenByReports: false },
    count,
    countingCount,
    reports: [],
  });

  it('shows how many reports count toward auto-hide when some do not', () => {
    h.me = { isReviewer: true, isAdmin: false, organizations: [] };
    h.reports = [item('mixed', 3, 2), item('all-count', 2, 2)];
    renderPage();
    fireEvent.click(screen.getByTestId('market-review-tab-reports'));
    expect(screen.getByTestId('market-report-item-mixed')).toHaveTextContent('3 reports (2 count toward auto-hide)');
    expect(screen.getByTestId('market-report-item-all-count')).toHaveTextContent('2 reports');
    expect(screen.getByTestId('market-report-item-all-count')).not.toHaveTextContent('count toward auto-hide');
  });
});
