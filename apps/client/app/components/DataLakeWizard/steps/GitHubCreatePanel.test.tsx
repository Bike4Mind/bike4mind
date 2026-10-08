import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { GITHUB_LAKE_FILE_RULES } from '@bike4mind/common';
import { formatBytes } from '@client/app/utils/folderTreeParser';

/**
 * The create-and-begin door this panel drives (POST /api/data-lakes/github-connect) is mocked at the
 * hook that owns it, so these tests never depend on the route existing.
 */
const h = vi.hoisted(() => ({
  beginMutate: vi.fn(),
  beginIsPending: false,
  saveHandoff: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/data/githubLakeCreate', () => ({
  useBeginGitHubLakeCreate: () => ({ mutate: h.beginMutate, isPending: h.beginIsPending }),
}));
vi.mock('@client/app/utils/githubLakeConnectHandoff', () => ({ saveGitHubLakeConnectHandoff: h.saveHandoff }));
vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn(), info: vi.fn() } }));

import GitHubCreatePanel, { GITHUB_READ_ONLY_PROMISE } from './GitHubCreatePanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const assign = vi.fn();

const renderPanel = (onBack = vi.fn()) => {
  wrap(<GitHubCreatePanel organizationId="org-1" onBack={onBack} />);
  return onBack;
};

/** Drive the mutation's callbacks the way react-query would. */
const resolveBegin = (response: { dataLakeId: string; authorizeUrl: string }) =>
  h.beginMutate.mockImplementation((_orgId: string, opts: { onSuccess: (r: unknown) => void }) =>
    opts.onSuccess(response)
  );
const rejectBegin = (error: unknown) =>
  h.beginMutate.mockImplementation((_orgId: string, opts: { onError: (e: unknown) => void }) => opts.onError(error));

/** getServerErrorField reads this through axios's own isAxiosError guard, so the flag is required. */
const serverRefusal = (message: string) => ({ isAxiosError: true, response: { data: { error: message } } });

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset, not clearAllMocks: the blocked-storage test installs a THROWING implementation, and
  // clearAllMocks leaves implementations in place - it would then throw for every later test.
  h.saveHandoff.mockReset();
  h.beginMutate.mockReset();
  h.beginIsPending = false;
  Object.defineProperty(window, 'location', { value: { assign, pathname: '/', search: '', hash: '' }, writable: true });
});

describe('GitHubCreatePanel - the read-only promise', () => {
  it('leads with the promise, which is the headline the user has to read', () => {
    renderPanel();
    expect(screen.getByTestId('github-read-only-promise')).toHaveTextContent(GITHUB_READ_ONLY_PROMISE);
    expect(GITHUB_READ_ONLY_PROMISE).toBe('We can read code, never write, push, or open PRs');
  });
});

/**
 * The disclosure renders FROM GITHUB_LAKE_FILE_RULES rather than from prose beside it, so these
 * assert against the constant: hand-written copy is exactly what would drift from the real filter.
 */
describe('GitHubCreatePanel - what gets synced', () => {
  it('stays collapsed until asked for', () => {
    renderPanel();
    expect(screen.getByTestId('github-synced-files-toggle-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('github-synced-files-details')).toBeNull();
  });

  it('lists every extension, denied folder and denied file the filter actually uses', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('github-synced-files-toggle-btn'));

    const details = screen.getByTestId('github-synced-files-details');
    expect(details).toHaveTextContent(GITHUB_LAKE_FILE_RULES.extensions.map(extension => `.${extension}`).join(', '));
    for (const name of GITHUB_LAKE_FILE_RULES.extensionlessNames) {
      expect(details).toHaveTextContent(name);
    }
    for (const segment of GITHUB_LAKE_FILE_RULES.deniedPathSegments) {
      expect(details).toHaveTextContent(segment);
    }
    for (const fileName of GITHUB_LAKE_FILE_RULES.deniedFileNames) {
      expect(details).toHaveTextContent(fileName);
    }
  });

  it('states the caps from the same constants', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('github-synced-files-toggle-btn'));

    const details = screen.getByTestId('github-synced-files-details');
    // Read off the rules so a changed cap updates the copy rather than this test.
    expect(details).toHaveTextContent(GITHUB_LAKE_FILE_RULES.maxCandidates.toLocaleString());
    expect(details).toHaveTextContent(formatBytes(GITHUB_LAKE_FILE_RULES.maxFileBytes));
  });

  it('collapses again on a second click', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('github-synced-files-toggle-btn'));
    fireEvent.click(screen.getByTestId('github-synced-files-toggle-btn'));
    expect(screen.queryByTestId('github-synced-files-details')).toBeNull();
  });
});

describe('GitHubCreatePanel - Continue', () => {
  it('calls the create-and-begin door with the org, then leaves for the authorize URL', async () => {
    resolveBegin({ dataLakeId: 'lake-1', authorizeUrl: 'https://github.com/login/oauth/authorize?state=s1' });
    renderPanel();

    fireEvent.click(screen.getByTestId('github-create-continue-btn'));

    expect(h.beginMutate).toHaveBeenCalledWith('org-1', expect.anything());
    // The handoff has to be saved BEFORE the redirect, or the callback page lands nowhere.
    expect(h.saveHandoff).toHaveBeenCalledWith({ dataLakeId: 'lake-1' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=s1'));
  });

  it('goes back to the cards without starting anything', () => {
    const onBack = renderPanel();
    fireEvent.click(screen.getByTestId('github-create-back-btn'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(h.beginMutate).not.toHaveBeenCalled();
  });
});

/**
 * Everything that can fail before the redirect renders INLINE with Try again, never as a toast: the
 * user is standing on this panel, and a toast disappears while the dead Continue button stays.
 */
describe('GitHubCreatePanel - failures before the redirect', () => {
  it("renders the server's refusal inline, not as a toast, and does not leave the page", () => {
    rejectBegin(serverRefusal('Organization not found'));
    renderPanel();

    fireEvent.click(screen.getByTestId('github-create-continue-btn'));

    expect(screen.getByTestId('github-create-error')).toHaveTextContent('Organization not found');
    expect(screen.getByTestId('github-create-retry-btn')).toBeInTheDocument();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the refusal carries none', () => {
    rejectBegin(new Error('boom'));
    renderPanel();

    fireEvent.click(screen.getByTestId('github-create-continue-btn'));

    expect(screen.getByTestId('github-create-error')).toHaveTextContent('Could not start the GitHub connection');
  });

  it('reports blocked session storage inline and never starts the round-trip', () => {
    resolveBegin({ dataLakeId: 'lake-1', authorizeUrl: 'https://github.com/login/oauth/authorize?state=s1' });
    h.saveHandoff.mockImplementation(() => {
      throw new Error('sessionStorage blocked');
    });
    renderPanel();

    fireEvent.click(screen.getByTestId('github-create-continue-btn'));

    expect(screen.getByTestId('github-create-error')).toHaveTextContent('blocked session storage');
    // The lake exists server-side by now, but without a handoff GitHub's return lands nowhere, so
    // leaving is worse than stopping here.
    expect(assign).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('retries the same call from the inline Try again, and clears the error on success', async () => {
    rejectBegin(serverRefusal('Temporary failure'));
    renderPanel();
    fireEvent.click(screen.getByTestId('github-create-continue-btn'));
    expect(screen.getByTestId('github-create-error')).toBeInTheDocument();

    resolveBegin({ dataLakeId: 'lake-2', authorizeUrl: 'https://github.com/login/oauth/authorize?state=s2' });
    fireEvent.click(screen.getByTestId('github-create-retry-btn'));

    expect(h.beginMutate).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId('github-create-error')).toBeNull());
    expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=s2');
  });
});
