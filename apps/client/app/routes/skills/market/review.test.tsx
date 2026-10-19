// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ me: { isReviewer: false, isAdmin: false, organizations: [] as unknown[] } }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMarketMe: () => ({ data: h.me, isLoading: false }),
  useReviewQueue: () => ({ data: [], isLoading: false, isError: false }),
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
