import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GitHubLakeRepositoryChoicesResponse } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  lakeId: 'lake1' as string | null,
  data: undefined as GitHubLakeRepositoryChoicesResponse | undefined,
  isLoading: false,
  isFetching: false,
  error: null as unknown,
  refetch: vi.fn(),
  completeMutate: vi.fn(),
  completeIsPending: false,
  closePicker: vi.fn(),
  beginReconnect: vi.fn(),
  reconnecting: false,
  saveHandoff: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (
    selector: (s: { gitHubRepoPickerLakeId: string | null; closeGitHubRepoPicker: () => void }) => unknown
  ) => selector({ gitHubRepoPickerLakeId: h.lakeId, closeGitHubRepoPicker: h.closePicker }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubRepositoryChoices: () => ({
    data: h.data,
    isLoading: h.isLoading,
    isFetching: h.isFetching,
    error: h.error,
    refetch: h.refetch,
  }),
  useCompleteLakeGitHubConnect: () => ({ mutate: h.completeMutate, isPending: h.completeIsPending }),
}));
vi.mock('@client/app/hooks/data/useBeginLakeGitHubConnect', () => ({
  useBeginLakeGitHubConnect: () => ({ begin: h.beginReconnect, isPending: h.reconnecting }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: h.saveHandoff }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));

import GitHubRepositoryPickerModal from './GitHubRepositoryPickerModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const INSTALL_URL = 'https://github.com/apps/lake-app/installations/new?state=s1';
const addReposUrl = (installationId: number) =>
  `https://github.com/apps/lake-app/installations/new/permissions?state=s1&target_id=${installationId}00`;
const assign = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  h.lakeId = 'lake1';
  h.data = undefined;
  h.isLoading = false;
  h.isFetching = false;
  h.error = null;
  h.completeIsPending = false;
  h.reconnecting = false;
  vi.stubGlobal('location', { assign });
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const choices = (over: Partial<GitHubLakeRepositoryChoicesResponse> = {}): GitHubLakeRepositoryChoicesResponse => ({
  installations: [],
  installUrl: INSTALL_URL,
  ...over,
});

describe('GitHubRepositoryPickerModal', () => {
  it('preselects the single eligible repository and confirms it', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [
            { id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null },
            {
              id: 101,
              fullName: 'acme/infra',
              defaultBranch: 'main',
              private: true,
              boundTo: { dataLakeName: 'Infra Lake' },
            },
          ],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByTestId('github-repo-picker-confirm-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('github-repo-picker-confirm-btn'));
    expect(h.completeMutate).toHaveBeenCalledWith(
      { dataLakeId: 'lake1', installationId: 10, repositoryId: 100 },
      expect.any(Object)
    );
  });

  it('disables a bound repository and names the lake it feeds', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [
            {
              id: 101,
              fullName: 'acme/infra',
              defaultBranch: 'main',
              private: true,
              boundTo: { dataLakeName: 'Infra Lake' },
            },
          ],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    const row = screen.getByTestId('github-repo-picker-row-101');
    expect(row).toHaveTextContent('Connected to Infra Lake');
    expect(row.querySelector('input[type="radio"]')).toBeDisabled();
  });

  it('shows a generic label for a repository bound to another organization lake', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [
            { id: 102, fullName: 'acme/shared', defaultBranch: 'main', private: true, boundTo: { dataLakeName: null } },
          ],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByTestId('github-repo-picker-row-102')).toHaveTextContent('Connected to another data lake');
  });

  it('shows the violation message and a "Fix on GitHub" link, with no repository rows or add-repositories action', () => {
    h.data = choices({
      installations: [
        {
          id: 20,
          accountLogin: 'naoya',
          accountType: 'User',
          settingsUrl: 'https://github.com/settings/installations/20',
          addRepositoriesUrl: addReposUrl(20),
          violation: { code: 'all_repositories', message: 'This installation grants access to all repositories.' },
          repositories: [],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    const violation = screen.getByTestId('github-repo-picker-violation-20');
    expect(violation).toHaveTextContent('This installation grants access to all repositories.');
    const link = screen.getByTestId('github-repo-picker-fix-link-20');
    expect(link).toHaveTextContent('Fix on GitHub');
    expect(link).toHaveAttribute('href', 'https://github.com/settings/installations/20');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByTestId(/github-repo-picker-row-/)).toBeNull();
    expect(screen.queryByTestId('github-repo-picker-add-repos-btn-20')).toBeNull();
  });

  it('filters repositories by full name, case-insensitively', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [
            { id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null },
            { id: 101, fullName: 'acme/infra', defaultBranch: 'main', private: false, boundTo: null },
          ],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    fireEvent.change(screen.getByTestId('github-repo-picker-search-input').querySelector('input')!, {
      target: { value: 'DOCS' },
    });

    expect(screen.getByTestId('github-repo-picker-row-100')).toBeInTheDocument();
    expect(screen.queryByTestId('github-repo-picker-row-101')).toBeNull();
  });

  it('shows the empty state when a search matches nothing', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [{ id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null }],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    fireEvent.change(screen.getByTestId('github-repo-picker-search-input').querySelector('input')!, {
      target: { value: 'nope' },
    });

    expect(screen.getByTestId('github-repo-picker-empty')).toBeInTheDocument();
  });

  it('drops the preselected repository once a search hides it', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [{ id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null }],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);
    expect(screen.getByTestId('github-repo-picker-confirm-btn')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('github-repo-picker-search-input').querySelector('input')!, {
      target: { value: 'nope' },
    });

    expect(screen.getByTestId('github-repo-picker-confirm-btn')).toBeDisabled();
  });

  it('says the App is not installed yet, rather than that no repository matched, with nothing installed', () => {
    h.data = choices({ installations: [] });
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByTestId('github-repo-picker-empty')).toHaveTextContent(/isn't installed on any account/i);
  });

  it('shows the reconnect door when the flow has expired', () => {
    h.error = {
      isAxiosError: true,
      response: { data: { error: 'Your GitHub authorization expired. Connect GitHub again.' } },
    };
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByTestId('github-repo-picker-error')).toHaveTextContent(
      'Your GitHub authorization expired. Connect GitHub again.'
    );
    fireEvent.click(screen.getByTestId('github-repo-picker-reconnect-btn'));
    expect(h.beginReconnect).toHaveBeenCalled();
  });

  it('saves the handoff and leaves for the install page from "Install on another account"', () => {
    h.data = choices({ installations: [] });
    wrap(<GitHubRepositoryPickerModal />);

    const install = screen.getByTestId('github-repo-picker-install-btn');
    expect(install).toHaveTextContent('Install on another account');
    fireEvent.click(install);

    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(INSTALL_URL);
  });

  it('hints that an org repo needs an owner when there is no organization installation', () => {
    h.data = choices({ installations: [] });
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByText(/needs an owner to install the App/)).toBeInTheDocument();
  });

  it('leads with "Add repositories to <account>" for an org, leaving for its targeted install URL', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    const add = screen.getByTestId('github-repo-picker-add-repos-btn-10');
    expect(add).toHaveTextContent('Add repositories to acme');
    expect(screen.getByTestId('github-repo-picker-add-repos-10')).toHaveTextContent(
      "Needs a GitHub org owner. If you're not one, GitHub lets you request it."
    );
    // The copyable request is a collapsed fallback, not a peer of the primary action.
    expect(screen.queryByTestId('github-repo-picker-request-repo-input-10')).toBeNull();

    fireEvent.click(add);
    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(addReposUrl(10));
  });

  it('offers "Add repositories" on a personal installation without the org-owner hint or request fallback', () => {
    h.data = choices({
      installations: [
        {
          id: 20,
          accountLogin: 'naoya',
          accountType: 'User',
          settingsUrl: 'https://github.com/settings/installations/20',
          addRepositoriesUrl: addReposUrl(20),
          violation: null,
          repositories: [],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    expect(screen.getByTestId('github-repo-picker-add-repos-btn-20')).toHaveTextContent('Add repositories to naoya');
    expect(screen.getByTestId('github-repo-picker-add-repos-20')).not.toHaveTextContent(/org owner/);
    expect(screen.queryByTestId('github-repo-picker-request-toggle-btn-20')).toBeNull();
  });

  it('copies the ask-an-owner request for an organization installation once the fallback is expanded', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);

    const toggle = screen.getByTestId('github-repo-picker-request-toggle-btn-10');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(screen.getByTestId('github-repo-picker-request-repo-input-10').querySelector('input')!, {
      target: { value: 'acme/private-repo' },
    });
    fireEvent.click(screen.getByTestId('github-repo-picker-copy-request-btn-10'));

    expect(writeText).toHaveBeenCalledWith(
      'Please add acme/private-repo to the data-lake GitHub App installation on acme ' +
        'so I can connect it to a data lake: https://github.com/organizations/acme/settings/installations/10'
    );
  });

  it('submits the repository the user picked, and drops the pick once a refresh shows it bound', () => {
    const repo = (id: number, boundTo: { dataLakeName: string | null } | null = null) => ({
      id,
      fullName: `acme/repo-${id}`,
      defaultBranch: 'main',
      private: false,
      boundTo,
    });
    const listing = (first: ReturnType<typeof repo>) =>
      choices({
        installations: [
          {
            id: 10,
            accountLogin: 'acme',
            accountType: 'Organization',
            settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
            addRepositoriesUrl: addReposUrl(10),
            violation: null,
            repositories: [first, repo(101), repo(102)],
          },
        ],
      });
    h.data = listing(repo(100));
    const { rerender } = wrap(<GitHubRepositoryPickerModal />);
    expect(screen.getByTestId('github-repo-picker-confirm-btn')).toBeDisabled();

    fireEvent.click(screen.getByTestId('github-repo-picker-row-100').querySelector('input')!);
    fireEvent.click(screen.getByTestId('github-repo-picker-confirm-btn'));
    expect(h.completeMutate).toHaveBeenCalledWith(
      { dataLakeId: 'lake1', installationId: 10, repositoryId: 100 },
      expect.anything()
    );

    h.data = listing(repo(100, { dataLakeName: 'Other lake' }));
    rerender(
      <CssVarsProvider theme={appTheme}>
        <GitHubRepositoryPickerModal />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('github-repo-picker-confirm-btn')).toBeDisabled();
  });

  it('closes the picker on cancel and on the close button', () => {
    h.data = choices({ installations: [] });
    wrap(<GitHubRepositoryPickerModal />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(h.closePicker).toHaveBeenCalled();
  });

  it('calls onSuccess handling: toasts and closes the picker when the connect completes', () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [{ id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null }],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);
    fireEvent.click(screen.getByTestId('github-repo-picker-confirm-btn'));

    const [, options] = h.completeMutate.mock.calls[0];
    options.onSuccess({ repositoryFullName: 'acme/docs' });

    expect(h.toastSuccess).toHaveBeenCalledWith('Connected acme/docs. Its first sync is queued.');
    expect(h.closePicker).toHaveBeenCalled();
  });

  it("surfaces the server's reason and keeps the modal open when the connect fails", () => {
    h.data = choices({
      installations: [
        {
          id: 10,
          accountLogin: 'acme',
          accountType: 'Organization',
          settingsUrl: 'https://github.com/organizations/acme/settings/installations/10',
          addRepositoriesUrl: addReposUrl(10),
          violation: null,
          repositories: [{ id: 100, fullName: 'acme/docs', defaultBranch: 'main', private: false, boundTo: null }],
        },
      ],
    });
    wrap(<GitHubRepositoryPickerModal />);
    fireEvent.click(screen.getByTestId('github-repo-picker-confirm-btn'));

    const [, options] = h.completeMutate.mock.calls[0];
    options.onError({
      isAxiosError: true,
      response: { data: { error: 'That repository was just connected elsewhere.' } },
    });

    expect(h.toastError).toHaveBeenCalledWith('That repository was just connected elsewhere.');
    expect(h.closePicker).not.toHaveBeenCalled();
  });

  it('renders nothing when the picker is closed (no lake id)', () => {
    h.lakeId = null;
    wrap(<GitHubRepositoryPickerModal />);
    expect(screen.queryByTestId('github-repo-picker-modal')).toBeNull();
  });
});
