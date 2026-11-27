// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  me: { isReviewer: false, isAdmin: false, organizations: [] as unknown[], spaces: [] as unknown[] },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/hooks/data/skills', () => ({ useGetSkills: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMarketMe: () => ({ data: h.me }),
  useMarketListings: () => ({ data: { pages: [{ data: [], hasMore: false }] }, isLoading: false, isError: false }),
  useRecommendedListings: () => ({ data: [], isLoading: false }),
}));
vi.mock('@client/app/components/SkillMarket/PublishDialog', () => ({ default: () => null }));

import SkillMarketPage from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillMarketPage />
    </CssVarsProvider>
  );

describe('SkillMarketPage review-queue link', () => {
  beforeEach(() => {
    h.me = { isReviewer: false, isAdmin: false, organizations: [], spaces: [] };
  });

  it('is hidden from a non-reviewer', () => {
    renderPage();
    expect(screen.getByTestId('market-page')).toBeInTheDocument();
    expect(screen.queryByTestId('market-review-queue-link')).toBeNull();
  });

  it('is shown to a reviewer', () => {
    h.me = { isReviewer: true, isAdmin: false, organizations: [], spaces: [] };
    renderPage();
    expect(screen.getByTestId('market-review-queue-link')).toBeInTheDocument();
  });
});

describe('SkillMarketPage Space scope', () => {
  it('offers My Spaces only to a member of a Space', async () => {
    h.me = { isReviewer: false, isAdmin: false, organizations: [], spaces: [] };
    const none = renderPage();
    await userEvent.click(screen.getByTestId('market-filter-scope'));
    expect(screen.queryByRole('option', { name: 'My Spaces' })).toBeNull();
    none.unmount();

    h.me = { isReviewer: false, isAdmin: false, organizations: [], spaces: [{ id: 'sp1', name: 'Platform' }] };
    renderPage();
    await userEvent.click(screen.getByTestId('market-filter-scope'));
    expect(await screen.findByRole('option', { name: 'My Spaces' })).toBeInTheDocument();
  });
});
