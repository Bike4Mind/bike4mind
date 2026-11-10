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
  detail: vi.fn(),
  search: {} as { campaignWatch?: string },
  admin: true,
  permissions: ['support:read'] as string[],
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
  useUser: () => ({ currentUser: { id: 'c'.repeat(24), isAdmin: mocks.admin, adminPermissions: mocks.permissions } }),
}));
vi.mock('@client/app/hooks/data/campaignWatches', async importOriginal => ({
  canUseCampaignWatches: (await importOriginal<typeof import('@client/app/hooks/data/campaignWatches')>())
    .canUseCampaignWatches,
  useCampaignWatches: (status: string, enabled: boolean) => {
    mocks.list(status, enabled);
    return {
      data: { pages: [{ items: [watch] }] },
      hasNextPage: true,
      fetchNextPage: mocks.more,
      refetch: mocks.refresh,
    };
  },
  useCampaignWatch: (_id: string | undefined, enabled: boolean) => {
    mocks.detail(enabled);
    return {
      data: {
        watch,
        ownerName: 'Example operator',
        members: [{ id: 'b'.repeat(24), name: 'Example account', available: true, suspended: false, credits: 100 }],
      },
      refetch: mocks.refresh,
    };
  },
  useChangeCampaignWatch: () => ({ mutateAsync: mocks.change, isPending: false }),
  watchErrorMessage: (error: Error) => error.message,
}));
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = {};
  mocks.admin = true;
  mocks.permissions = ['support:read'];
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
  expect(mocks.list).toHaveBeenLastCalledWith('closed', true);
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

it('shows a full administrator the activity links and mutation controls', () => {
  mocks.search = { campaignWatch: watch.id };
  render(<CampaignWatchesPanel />, { wrapper: Wrapper });
  expect(screen.getByRole('link', { name: 'View activity' })).toBeInTheDocument();
  expect(screen.getByTestId('campaign-watch-close-btn')).toBeInTheDocument();
  expect(screen.getByTestId('campaign-watch-check-btn')).toBeInTheDocument();
});

it.each([['support:read'], ['users:moderate']])(
  'renders nothing and fires no request for a %s delegate who is not a full administrator',
  permission => {
    mocks.search = { campaignWatch: watch.id };
    mocks.admin = false;
    mocks.permissions = [permission];
    const { container } = render(<CampaignWatchesPanel />, { wrapper: Wrapper });
    expect(container).toBeEmptyDOMElement();
    expect(mocks.list).toHaveBeenCalledWith('open', false);
    expect(mocks.detail).toHaveBeenCalledWith(false);
    expect(mocks.list).not.toHaveBeenCalledWith(expect.anything(), true);
    expect(mocks.detail).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole('link', { name: 'View activity' })).not.toBeInTheDocument();
  }
);
