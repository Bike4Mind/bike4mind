import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { GroupProjectSharing } from './GroupProjectSharing';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'owner' } }) }));
vi.mock('@client/app/utils/groupsAPICalls', () => ({ shareGroupProject: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const theme = extendTheme({ ...getThemeConfig() });
const loaded = { data: { data: [{ id: 'mine', name: 'My project', userId: 'owner', groups: [] }], hasMore: false } };
const setup = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <GroupProjectSharing organizationId="org" groupId="group" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByTestId('org-group-projects-group'));
  return { queryClient, view };
};
beforeEach(() => {
  get.mockReset();
});

describe('group project picker real query failures', () => {
  it('shows initial request failure and retries to loaded owned projects instead of claiming an empty list', async () => {
    get.mockRejectedValue(new Error('unavailable'));
    const { queryClient, view } = setup();
    expect(await screen.findByTestId('org-group-projects-error')).toHaveTextContent('Could not load projects');
    expect(screen.queryByText('No owned projects on this page.')).not.toBeInTheDocument();
    get.mockResolvedValue(loaded);
    fireEvent.click(screen.getByTestId('org-group-projects-retry'));
    expect(await screen.findByTestId('org-group-share-mine')).toBeEnabled();
    expect(screen.queryByTestId('org-group-projects-error')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({ params: expect.objectContaining({ search: '' }) })
    );
    view.unmount();
    queryClient.clear();
  });

  it('keeps loaded choices visible and offers Retry after a failed refresh', async () => {
    get.mockResolvedValue(loaded);
    const { queryClient, view } = setup();
    expect(await screen.findByTestId('org-group-share-mine')).toBeEnabled();
    get.mockRejectedValue(new Error('unavailable'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects', 'search'] });
    });
    expect(await screen.findByTestId('org-group-projects-error')).toHaveTextContent('Showing the last loaded list');
    expect(screen.getByTestId('org-group-share-mine')).toBeEnabled();
    get.mockResolvedValue(loaded);
    fireEvent.click(screen.getByTestId('org-group-projects-retry'));
    await screen.findByTestId('org-group-share-mine');
    view.unmount();
    queryClient.clear();
  });
});
