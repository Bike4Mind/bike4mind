import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { GroupProjectSharing } from './GroupProjectSharing';

const shareGroupProject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@client/app/utils/groupsAPICalls', () => ({ shareGroupProject }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'owner' } }) }));
vi.mock('@client/app/hooks/data/projects', () => ({
  useSearchProjects: () => ({
    data: {
      pages: [
        {
          data: [
            { id: 'mine', name: 'My project', userId: 'owner', groups: [] },
            { id: 'shared', name: 'Shared project', userId: 'owner', groups: [{ groupId: 'group' }] },
            { id: 'foreign', name: 'Foreign project', userId: 'other', groups: [] },
          ],
        },
      ],
    },
    isPending: false,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('GroupProjectSharing', () => {
  it('shares and revokes only owned projects through the group endpoint', async () => {
    const theme = extendTheme({ ...getThemeConfig() });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={theme}>
          <GroupProjectSharing organizationId="org" groupId="group" />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByTestId('org-group-projects-group'));
    expect(screen.queryByTestId('org-group-share-foreign')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-group-share-mine'));
    await waitFor(() => expect(shareGroupProject).toHaveBeenCalledWith('org', 'group', 'mine', true));
    await waitFor(() => expect(screen.getByTestId('org-group-share-shared')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('org-group-share-shared'));
    await waitFor(() => expect(shareGroupProject).toHaveBeenCalledWith('org', 'group', 'shared', false));
  });
});
