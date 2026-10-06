import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  openManager: vi.fn(),
  openGitHubRepoPicker: vi.fn(),
  authorizeMutate: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: h.push, replace: h.replace } }),
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (
    selector: (s: { openManager: typeof h.openManager; openGitHubRepoPicker: typeof h.openGitHubRepoPicker }) => unknown
  ) => selector({ openManager: h.openManager, openGitHubRepoPicker: h.openGitHubRepoPicker }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useAuthorizeLakeGitHubConnect: () => ({ mutate: h.authorizeMutate }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError, info: h.toastInfo } }));

import GitHubLakeCallbackPage from './callback';
import { readGitHubLakeConnectHandoff, saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';
import { captureGitHubLakeCallbackSearch, GITHUB_LAKE_CALLBACK_PATH } from '@client/app/utils/githubLakeCallbackSearch';

let currentSearch = '';
let currentPathname = '/';
const setSearch = (params: Record<string, string>) => {
  currentSearch = `?${new URLSearchParams(params).toString()}`;
};
const saveRawHandoff = (handoff: Record<string, string>) =>
  sessionStorage.setItem('b4m:github-lake-connect', JSON.stringify(handoff));
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
  saveGitHubLakeConnectHandoff({ dataLakeId: 'lake1' });
  currentSearch = '';
  currentPathname = '/';
  vi.stubGlobal('location', {
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
  it('exchanges the single-use code exactly once, even under StrictMode double effects', () => {
    setSearch({ code: 'c1', state: 's1' });
    render(
      <StrictMode>
        <CssVarsProvider theme={appTheme}>
          <GitHubLakeCallbackPage />
        </CssVarsProvider>
      </StrictMode>
    );
    expect(h.authorizeMutate).toHaveBeenCalledTimes(1);
    expect(h.authorizeMutate).toHaveBeenCalledWith({ state: 's1', code: 'c1' }, expect.any(Object));
  });

  it('passes an all-digit code through as the exact string, not a JSON-parsed number', () => {
    setSearch({ code: '12345678901234567890', state: 's1' });
    renderPage();
    expect(h.authorizeMutate).toHaveBeenCalledWith({ state: 's1', code: '12345678901234567890' }, expect.any(Object));
  });

  it('passes a digits-and-e code through intact', () => {
    setSearch({ code: '0e12345678901234567', state: 's1' });
    renderPage();
    expect(h.authorizeMutate).toHaveBeenCalledWith({ state: 's1', code: '0e12345678901234567' }, expect.any(Object));
  });

  it('reads the query GitHub sent, not the URL the router rewrote before the page mounted', () => {
    currentPathname = GITHUB_LAKE_CALLBACK_PATH;
    setSearch({ code: '12345678901234567890', state: 's1' });
    captureGitHubLakeCallbackSearch();
    // What the router leaves in the address bar: the all-digit code parsed and rounded.
    currentSearch = '?code=%2212345678901234567000%22&state=s1';
    renderPage();
    expect(h.authorizeMutate).toHaveBeenCalledWith({ state: 's1', code: '12345678901234567890' }, expect.any(Object));
  });

  it('lands on the lake and opens the repository picker once the authorize exchange succeeds', () => {
    setSearch({ code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.authorizeMutate.mock.calls[0];
    options.onSuccess({ dataLakeId: 'lake1' });

    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).toHaveBeenCalledWith('lake1');
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it("shows the server's reason and lands without opening the picker when the exchange fails", () => {
    setSearch({ code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.authorizeMutate.mock.calls[0];
    options.onError({
      isAxiosError: true,
      response: { data: { error: 'This authorization already expired.' } },
    });
    expect(h.toastError).toHaveBeenCalledWith('This authorization already expired.');
    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).not.toHaveBeenCalled();
  });

  it('falls back to a generic notice when the server gives no reason', () => {
    setSearch({ code: 'c1', state: 's1' });
    renderPage();

    const [, options] = h.authorizeMutate.mock.calls[0];
    options.onError(new Error('Network Error'));
    expect(h.toastError).toHaveBeenCalledWith('Could not connect GitHub.');
  });

  it('asks for a restart and returns to the lake when GitHub sends back no state', () => {
    setSearch({});
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(RESTART_NOTICE);
    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).not.toHaveBeenCalled();
    expect(h.authorizeMutate).not.toHaveBeenCalled();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it('asks for a restart without opening a lake when the handoff is gone', () => {
    sessionStorage.clear();
    setSearch({ code: 'c1', state: 's1' });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith(RESTART_NOTICE);
    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).not.toHaveBeenCalled();
    expect(h.authorizeMutate).not.toHaveBeenCalled();
  });

  it('reopens the picker with no server call when the install fallback returns with no code', () => {
    setSearch({ installation_id: '42', state: 's1' });
    renderPage();

    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).toHaveBeenCalledWith('lake1');
    expect(h.authorizeMutate).not.toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it('returns to the lake with a cancel notice when the user declines on GitHub', () => {
    setSearch({ error: 'access_denied', state: 's1' });
    renderPage();

    expect(h.toastError).toHaveBeenCalledWith('GitHub connection cancelled.');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).not.toHaveBeenCalled();
    expect(h.authorizeMutate).not.toHaveBeenCalled();
  });

  it('reopens the picker with an info notice when the install needs org-owner approval', () => {
    setSearch({ setup_action: 'request', state: 's1' });
    renderPage();

    expect(h.toastInfo).toHaveBeenCalledWith(
      'GitHub sent the install request to an organization owner. Once they approve it, refresh the repository list.'
    );
    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).toHaveBeenCalledWith('lake1');
    expect(h.authorizeMutate).not.toHaveBeenCalled();
  });

  it('returns to the page the connect started from, replacing the callback in history', () => {
    saveRawHandoff({ dataLakeId: 'lake1', returnPath: '/projects/p1?tab=files#x' });
    setSearch({ installation_id: '42', state: 's1' });
    renderPage();

    expect(h.replace).toHaveBeenCalledWith('/projects/p1?tab=files#x');
    expect(h.push).not.toHaveBeenCalled();
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).toHaveBeenCalledWith('lake1');
  });

  it('returns to the starting page without the picker when the user cancels', () => {
    saveRawHandoff({ dataLakeId: 'lake1', returnPath: '/projects/p1' });
    setSearch({ error: 'access_denied', state: 's1' });
    renderPage();

    expect(h.replace).toHaveBeenCalledWith('/projects/p1');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
    expect(h.openGitHubRepoPicker).not.toHaveBeenCalled();
  });

  it('lands on / when the stored return path is not a same-origin path', () => {
    saveRawHandoff({ dataLakeId: 'lake1', returnPath: '//evil.com' });
    setSearch({ installation_id: '42', state: 's1' });
    renderPage();

    expect(h.replace).toHaveBeenCalledWith('/');
    expect(h.openManager).toHaveBeenCalledWith('mine', 'lake1');
  });
});
