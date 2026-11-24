// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  listings: [] as unknown[],
  deleteMutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/hooks/data/skills', () => ({ useGetSkills: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMyListings: () => ({ data: h.listings, isLoading: false, isError: false }),
  useRescanVersion: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSubmitNewVersion: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWithdrawListing: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteListing: () => ({ mutateAsync: h.deleteMutate, isPending: false }),
}));
vi.mock('@client/app/components/SkillMarket/PublishDialog', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import MyListingsPage from './mine';

const appTheme = extendTheme({ ...getThemeConfig() });

const listing = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  name,
  status: 'withdrawn',
  visibility: 'public',
  hiddenByReports: false,
  ratingAvg: 0,
  ratingCount: 0,
  importCount: 0,
  versions: [],
  ...extra,
});

const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MyListingsPage />
    </CssVarsProvider>
  );

describe('MyListingsPage permanent delete', () => {
  beforeEach(() => {
    h.deleteMutate.mockReset().mockResolvedValue(undefined);
    h.listings = [
      listing('gone'),
      listing('live', { status: 'approved' }),
      listing('held', { status: 'in_review' }),
      listing('takedown', { status: 'delisted' }),
      listing('reported', { hiddenByReports: true }),
    ];
  });

  it('offers Delete permanently on a withdrawn listing only', () => {
    renderPage();
    expect(screen.getByTestId('market-mine-delete-gone')).toBeInTheDocument();
    for (const name of ['live', 'held', 'takedown', 'reported']) {
      expect(screen.queryByTestId(`market-mine-delete-${name}`)).toBeNull();
    }
  });

  it('deletes after the confirm and does nothing when it is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();
    fireEvent.click(screen.getByTestId('market-mine-delete-gone'));
    expect(h.deleteMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('market-mine-delete-gone'));
    await waitFor(() => expect(h.deleteMutate).toHaveBeenCalledWith('id-gone'));
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe('MyListingsPage template entry points', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    h.navigate.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    h.listings = [
      listing('live', { status: 'approved', template: null }),
      listing('shared', { status: 'approved', template: { slug: 'shared-page', status: 'published' } }),
      listing('drafted', { status: 'approved', template: { slug: 'drafted-page', status: 'draft' } }),
      listing('held', { status: 'in_review' }),
    ];
  });

  it('offers View as template on an approved listing only, and opens the editor', () => {
    renderPage();
    for (const name of ['live', 'shared', 'drafted']) {
      expect(screen.getByTestId(`market-mine-template-${name}`)).toHaveTextContent('View as template');
    }
    expect(screen.queryByTestId('market-mine-template-held')).toBeNull();

    fireEvent.click(screen.getByTestId('market-mine-template-live'));
    expect(h.navigate).toHaveBeenCalledWith({
      to: '/skills/market/$listingId/template',
      params: { listingId: 'id-live' },
    });
  });

  it('offers Copy template link only for a published template and copies its page URL', async () => {
    renderPage();
    expect(screen.queryByTestId('market-mine-copy-template-link-live')).toBeNull();
    expect(screen.queryByTestId('market-mine-copy-template-link-drafted')).toBeNull();

    fireEvent.click(screen.getByTestId('market-mine-copy-template-link-shared'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/t/shared-page`));
  });
});
