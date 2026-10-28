import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IUser } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  useGetFabFile: vi.fn(),
  updateUserToServer: vi.fn(),
}));

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFile: (id: string) => mocks.useGetFabFile(id),
  useGetFabFiles: () => ({ data: { pages: [] }, isFetching: false }),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({
  updateUserToServer: (...a: unknown[]) => mocks.updateUserToServer(...a),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('../Knowledge/KnowledgeModal', () => ({
  useKnowledgeModal: () => ({ setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: [] }),
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ isAdmin: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SystemPromptsTab } from './SystemPromptsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const user = {
  id: 'u1',
  systemFiles: [
    { fileId: 'live', enabled: true },
    { fileId: 'gone', enabled: true },
  ],
} as unknown as IUser;

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <SystemPromptsTab user={user} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

describe('SystemPromptsTab - a pinned file that can no longer be loaded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useGetFabFile.mockImplementation((id: string) =>
      id === 'live'
        ? { data: { id: 'live', fileName: 'style-guide.md', mimeType: 'text/markdown' }, isLoading: false }
        : { data: undefined, isLoading: false, isError: true }
    );
    mocks.updateUserToServer.mockImplementation(async (_id: string, patch: Partial<IUser>) => ({ ...user, ...patch }));
  });

  it('shows it as unavailable instead of hiding it, next to the files that load', () => {
    renderTab();

    expect(screen.getByText('style-guide.md')).toBeTruthy();
    expect(screen.getAllByTestId('system-prompt-unavailable-row')).toHaveLength(1);
    expect(screen.getByText('Unavailable file')).toBeTruthy();
  });

  it('removes only that entry from the user system files', async () => {
    renderTab();

    fireEvent.click(screen.getByTestId('system-prompt-unavailable-remove-btn'));

    await waitFor(() =>
      expect(mocks.updateUserToServer).toHaveBeenCalledWith('u1', {
        systemFiles: [{ fileId: 'live', enabled: true }],
      })
    );
    await waitFor(() => expect(screen.queryByTestId('system-prompt-unavailable-row')).toBeNull());
  });

  it('shows nothing for a file that is still loading', () => {
    mocks.useGetFabFile.mockReturnValue({ data: undefined, isLoading: true });
    renderTab();

    expect(screen.queryByTestId('system-prompt-unavailable-row')).toBeNull();
  });
});
