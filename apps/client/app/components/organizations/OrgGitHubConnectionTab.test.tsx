import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrgGitHubConnectionTab from './OrgGitHubConnectionTab';

const { updateMutate, idleMutation, connectionData, reposData } = vi.hoisted(() => ({
  reposData: {
    hasMore: false,
    repositories: [
      { id: 1, full_name: 'acme/one', private: false },
      { id: 2, full_name: 'acme/two', private: true },
    ],
  },
  connectionData: {
    connected: true,
    connection: {
      id: 'conn-1',
      connectionType: 'github_app',
      appId: '123',
      installationId: '456',
      connectedAt: '2026-01-01T00:00:00.000Z',
      allowedRepositories: ['acme/one'],
      health: {},
    },
  },
  updateMutate: vi.fn(),
  idleMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-router', () => ({ useBlocker: () => ({ status: 'idle' }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/useOrgGitHubConnection', () => ({
  useGetOrgGitHubConnection: () => ({ data: connectionData, isLoading: false, refetch: vi.fn() }),
  useGetOrgGitHubRateLimit: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
  useCreateOrgGitHubConnection: idleMutation,
  useUpdateOrgGitHubConnection: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteOrgGitHubConnection: idleMutation,
  useTestOrgGitHubConnection: idleMutation,
  useRotateOrgGitHubKey: idleMutation,
  useRotateOrgGitHubPAT: idleMutation,
}));
vi.mock('@client/app/hooks/data/useGitHubRepositories', () => ({
  useOrgGitHubRepositories: () => ({ data: reposData, isLoading: false, error: null }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () => render(<OrgGitHubConnectionTab orgId="org-1" />, { wrapper: TestWrapper });

const startEditing = () => fireEvent.click(screen.getByTestId('org-github-edit-repos-btn'));
const toggleRepo = (id: number) =>
  fireEvent.click(screen.getByTestId(`org-github-repo-checkbox-${id}`).querySelector('input') as HTMLInputElement);

describe('OrgGitHubConnectionTab allowed repositories', () => {
  beforeEach(() => {
    updateMutate.mockReset();
  });

  it('shows no save bar until the edit staged a change', () => {
    renderTab();
    startEditing();
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
  });

  it('counts staged picks and removals in the save bar', () => {
    renderTab();
    startEditing();
    toggleRepo(2);
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('1 unsaved change');

    toggleRepo(1);
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('2 unsaved changes');
  });

  it('offers Close only while there are no staged changes', () => {
    renderTab();
    startEditing();
    expect(screen.getByTestId('org-github-close-repos-btn')).toBeTruthy();

    toggleRepo(2);
    expect(screen.queryByTestId('org-github-close-repos-btn')).toBeNull();

    toggleRepo(2);
    fireEvent.click(screen.getByTestId('org-github-close-repos-btn'));
    expect(screen.queryByTestId('org-github-repo-search-input')).toBeNull();
    expect(screen.getByTestId('org-github-edit-repos-btn')).toBeTruthy();
  });

  it('Discard restores the saved list and leaves the edit state', () => {
    renderTab();
    startEditing();
    toggleRepo(2);

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(screen.queryByTestId('org-github-repo-search-input')).toBeNull();
    startEditing();
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect((screen.getByTestId('org-github-repo-checkbox-2').querySelector('input') as HTMLInputElement).checked).toBe(
      false
    );
  });

  it('Save sends the staged list', () => {
    renderTab();
    startEditing();
    toggleRepo(2);

    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { orgId: 'org-1', data: { allowedRepositories: ['acme/one', 'acme/two'] } },
      expect.any(Object)
    );
  });
});
