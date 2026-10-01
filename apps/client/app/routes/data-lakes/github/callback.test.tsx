import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  openManager: vi.fn(),
  completeMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: typeof h.openManager }) => unknown) =>
    selector({ openManager: h.openManager }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useCompleteLakeGitHubConnect: () => ({ mutate: h.completeMutate }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));
vi.mock('@client/app/utils/githubLakeConnectHandoff', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/utils/githubLakeConnectHandoff')>();
  // Wraps the real save so most tests still exercise actual sessionStorage read/write/clear;
  // the storage-blocked test overrides this one call with mockImplementationOnce.
  return { ...actual, saveGitHubLakeConnectHandoff: vi.fn(actual.saveGitHubLakeConnectHandoff) };
});

import GitHubLakeCallbackPage from './callback';
import { readGitHubLakeConnectHandoff, saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';
import { captureGitHubLakeCallbackSearch, GITHUB_LAKE_CALLBACK_PATH } from '@client/app/utils/githubLakeCallbackSearch';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=c&state=s1';
const assign = vi.fn();
let currentSearch = '';
let currentPathname = '/';
const setSearch = (params: Record<string, string>) => {
  currentSearch = `?${new URLSearchParams(params).toString()}`;
};
const RESTART_NOTICE = 'The GitHub connection could not be completed. Start it again from the data lake.';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GitHubLakeCallbackPage />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  saveGitHubLakeConnectHandoff({ dataLakeId: 'lake1', authorizeUrl: AUTHORIZE_URL });
  currentSearch = '';
  currentPathname = '/';
  vi.stubGlobal('location', {
    assign,
    get search() {
      return currentSearch;
    },
    get pathname() {
      return currentPathname;
    },
  });
  captureGitHubLakeCallbackSearch(); // reset: this page load did not land on the callback
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubLakeCallbackPage', () => {
  it('posts the single-use code exactly once, even under StrictMode double effects', () => {
    setSearch({ installation_id: '42', code: 'c1', state: 's1' });
    render(
      <StrictMode>
        <CssVarsProvider theme={appTheme}>
          <GitHubLakeCallbackPage />
        </CssVarsProvider>
      </StrictMode>
    );
    expect(h.completeMutate).toHaveBeenCalledTimes(1);
    expect(h.completeMutate).toHaveBeenCalledWith({ state: 's1', code: 'c1', installationId: 42 }, expect.any(Object));
  });

  it('passes an all-digit code through as the exact string, not a JSON-parsed number', () => {
    setSearch({ installation_id: '42', code: '12345678901234567890', state: 's1' });
    renderPage();
    expect(h.completeMutate).toHaveBeenCalledWith(
      { state: 's1', code: '12345678901234567890', installationId: 42 },
      expect.any(Object)
    );
  });

  it('passes a digits-and-e code through intact', () => {
    setSearch({ installation_id: '42', code: '0e12345678901234567', state: 's1' });
    renderPage();
    expect(h.completeMutate).toHaveBeenCalledWith(
      { state: 's1', code: '0e12345678901234567', installationId: 42 },
      expect.any(Object)
    );
  });

  it('reads the query GitHub sent, not the URL the router rewrote before the page mounted', () => {
    currentPathname = GITHUB_LAKE_CALLBACK_PATH;
    setSearch({ installation_id: '42', code: '12345678901234567890', state: 's1' });
    captureGitHubLakeCallbackSearch();
    // What the router leaves in the address bar: the id JSON-quoted, the all-digit code parsed and rounded.
    currentSearch = '?installation_id=%2242%22&code=%2212345678901234567000%22&state=s1';
    renderPage();
    expect(h.completeMutate).toHaveBeenCalledWith(
      { state: 's1', code: '12345678901234567890', installationId: 42 },
      expect.any(Object)
    );
  });

  it('lands on the lake in the manager and clears the handoff once the connect settles', () => {
    setSearch({ installation_id: '42', code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.completeMutate.mock.calls[0];
    options.onSuccess({ repositoryFullName: 'acme/docs' });
    options.onSettled();

    expect(h.toastSuccess).toHaveBeenCalledWith('Connected acme/docs. Its first sync is queued.');
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it("shows the server's reason when binding fails", () => {
    setSearch({ installation_id: '42', code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.completeMutate.mock.calls[0];
    options.onError({
      isAxiosError: true,
      response: { data: { error: 'The GitHub App was installed on all repositories.' } },
    });
    expect(h.toastError).toHaveBeenCalledWith('The GitHub App was installed on all repositories.');
  });

  it('falls back to a generic notice when the server gives no reason', () => {
    setSearch({ installation_id: '42', code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.completeMutate.mock.calls[0];
    options.onError(new Error('Network Error'));
    expect(h.toastError).toHaveBeenCalledWith('Could not connect the GitHub repository.');
  });

  it('asks for a restart and returns to the lake when GitHub sends back no state', () => {
    setSearch({});
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(RESTART_NOTICE);
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.completeMutate).not.toHaveBeenCalled();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it('asks for a restart without opening a lake when the handoff is gone', () => {
    sessionStorage.clear();
    setSearch({ installation_id: '42', code: 'c1', state: 's1' });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(RESTART_NOTICE);
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(h.openManager).not.toHaveBeenCalled();
    expect(h.completeMutate).not.toHaveBeenCalled();
  });

  it('bounces an install with no code through authorize, keeping the installation id', () => {
    setSearch({ installation_id: '42', state: 's1' });
    renderPage();

    expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(readGitHubLakeConnectHandoff()).toMatchObject({ installationId: 42 });
    expect(h.completeMutate).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('returns to the lake with a cancel notice when the user declines on GitHub', () => {
    setSearch({ error: 'access_denied', state: 's1' });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith('GitHub connection cancelled.');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.completeMutate).not.toHaveBeenCalled();
  });

  it('shows a failure notice and returns to the lake when the install needs org-owner approval', () => {
    setSearch({ setup_action: 'request', state: 's1' });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(
      'GitHub sent the install to an owner of that organization for approval. Connect the repository again once they approve it.'
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.completeMutate).not.toHaveBeenCalled();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it('shows a storage-blocked notice when the authorize handoff cannot be saved', () => {
    setSearch({ installation_id: '42', state: 's1' });
    vi.mocked(saveGitHubLakeConnectHandoff).mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(
      'Could not continue the GitHub connection: this browser blocked session storage.'
    );
    expect(assign).not.toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
  });
});
