import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { CampaignWatchesPanel } from './CampaignWatchesPanel';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  change: vi.fn(),
  refresh: vi.fn(),
  more: vi.fn(),
  list: vi.fn(),
  search: {} as { campaignWatch?: string },
  admin: true,
}));
const watch = {
  id: 'a'.repeat(24),
  name: 'Example watch',
  userIds: ['b'.repeat(24)],
  ownerId: 'c'.repeat(24),
  status: 'open',
  revision: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
  sourceDetectionId: null,
  closedAt: null,
  lastCheckedAt: null,
};
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate, useSearch: () => mocks.search }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'c'.repeat(24), isAdmin: mocks.admin, adminPermissions: ['support:read'] } }),
}));
vi.mock('@client/app/hooks/data/campaignWatches', () => ({
  useCampaignWatches: (status: string) => {
    mocks.list(status);
    return {
      data: { pages: [{ items: [watch] }] },
      hasNextPage: true,
      fetchNextPage: mocks.more,
      refetch: mocks.refresh,
    };
  },
  useCampaignWatch: () => ({
    data: {
      watch,
      ownerName: 'Example operator',
      members: [{ id: 'b'.repeat(24), name: 'Example account', available: true, suspended: false, credits: 100 }],
    },
    refetch: mocks.refresh,
  }),
  useChangeCampaignWatch: () => ({ mutateAsync: mocks.change, isPending: false }),
  watchErrorMessage: (error: Error) => error.message,
}));
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = {};
  mocks.admin = true;
  mocks.change.mockResolvedValue(watch);
});

it('opens a durable link and exposes closed history and server pagination', () => {
  render(<CampaignWatchesPanel />, { wrapper: Wrapper });
  fireEvent.click(screen.getByTestId(`campaign-watch-open-${watch.id}`));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/admin',
    search: { tab: 'shadow-detections', campaignWatch: watch.id },
  });
  fireEvent.click(screen.getByTestId('campaign-watches-closed-btn'));
  expect(mocks.list).toHaveBeenLastCalledWith('closed');
  fireEvent.click(screen.getByTestId('campaign-watches-more-btn'));
  expect(mocks.more).toHaveBeenCalledOnce();
});

it('shows exact profile/activity links, refreshes details, and records a reasoned manual check', async () => {
  mocks.search = { campaignWatch: watch.id };
  render(<CampaignWatchesPanel />, { wrapper: Wrapper });
  expect(screen.getByRole('link', { name: 'View activity' })).toHaveAttribute(
    'href',
    `/admin/users/${watch.userIds[0]}?tab=activity`
  );
  expect(screen.getByRole('link', { name: 'Example account' })).toHaveAttribute(
    'href',
    `/admin/users/${watch.userIds[0]}`
  );
  fireEvent.click(screen.getByTestId('campaign-watch-refresh-btn'));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTestId('campaign-watch-check-btn'));
  fireEvent.click(screen.getByTestId('campaign-watch-action-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('campaign-watch-action-dialog-confirm-btn'));
  await waitFor(() =>
    expect(mocks.change).toHaveBeenCalledWith({
      action: 'check',
      expectedRevision: 3,
      reason: 'Reviewed account activity',
    })
  );
});

it('lets support readers view accounts without watch mutation controls', () => {
  mocks.search = { campaignWatch: watch.id };
  mocks.admin = false;
  render(<CampaignWatchesPanel />, { wrapper: Wrapper });
  expect(screen.getByRole('link', { name: 'View activity' })).toBeInTheDocument();
  expect(screen.queryByTestId('campaign-watch-close-btn')).not.toBeInTheDocument();
  expect(screen.queryByTestId('campaign-watch-check-btn')).not.toBeInTheDocument();
});
