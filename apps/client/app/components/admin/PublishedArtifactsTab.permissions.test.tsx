import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import PublishedArtifactsTab from './PublishedArtifactsTab';

const state = vi.hoisted(() => ({
  currentUser: { isAdmin: false, adminPermissions: ['users:moderate'] },
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: state.get, post: state.post, delete: state.delete } }));
const artifacts = [
  {
    publicId: 'active',
    tier: 'user',
    scopeId: 'target',
    slug: 'page',
    title: 'Active page',
    moderationStatus: 'active',
    reportCount: 0,
  },
  {
    publicId: 'removed',
    tier: 'user',
    scopeId: 'target',
    slug: 'removed',
    title: 'Removed page',
    moderationStatus: 'taken_down',
    reportCount: 0,
  },
];
const renderPages = () =>
  render(<PublishedArtifactsTab />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>{children}</CssVarsProvider>
      </QueryClientProvider>
    ),
  });

describe('published page moderation permission', () => {
  it('lets a moderator take down and restore pages without settings access', async () => {
    state.currentUser.adminPermissions = ['users:moderate'];
    state.get.mockResolvedValue({ data: { artifacts, total: 2 } });
    state.post.mockResolvedValue({ data: {} });
    state.delete.mockResolvedValue({ data: {} });
    vi.spyOn(window, 'prompt').mockReturnValue('Confirmed abuse');
    renderPages();
    fireEvent.click(await screen.findByTestId('admin-published-takedown-active'));
    await waitFor(() =>
      expect(state.post).toHaveBeenCalledWith('/api/admin/published-artifacts/active/takedown', {
        reason: 'Confirmed abuse',
      })
    );
    fireEvent.click(screen.getByTestId('admin-published-restore-removed'));
    await waitFor(() => expect(state.delete).toHaveBeenCalledWith('/api/admin/published-artifacts/removed/takedown'));
  });
  it('keeps settings-only readers from moderating published pages', async () => {
    state.currentUser.adminPermissions = ['settings:manage'];
    state.get.mockResolvedValue({ data: { artifacts, total: 2 } });
    renderPages();
    expect(await screen.findByTestId('admin-published-takedown-active')).toBeDisabled();
    expect(screen.getByTestId('admin-published-restore-removed')).toBeDisabled();
    expect(screen.getByText('Missing permission: users:moderate')).toBeInTheDocument();
  });
});
