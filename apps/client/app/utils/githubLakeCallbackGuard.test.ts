import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import { requireGitHubLakeCallbackSession } from '@client/app/utils/githubLakeCallbackGuard';

const { bootstrapSession, getState, getBootSearch } = vi.hoisted(() => ({
  bootstrapSession: vi.fn(),
  getState: vi.fn(),
  getBootSearch: vi.fn(),
}));

vi.mock('@client/app/utils/sessionBootstrap', () => ({ bootstrapSession }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: { getState } }));
vi.mock('@client/app/utils/githubLakeCallbackSearch', () => ({ getGitHubLakeCallbackBootSearch: getBootSearch }));

const callbackLocation = {
  pathname: '/data-lakes/github/callback',
  searchStr: '?installation_id=%2242%22&code=c1&state=s1',
};

const thrownBy = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the guard to throw');
};

describe('requireGitHubLakeCallbackSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapSession.mockResolvedValue(undefined);
    getBootSearch.mockReturnValue('?installation_id=42&code=c1&state=s1');
  });

  it('waits for the session bootstrap before letting the page mount', async () => {
    let finishBootstrap = () => {};
    bootstrapSession.mockReturnValue(new Promise<void>(resolve => (finishBootstrap = resolve)));
    getState.mockReturnValue({ currentUser: { id: 'u1' } });

    let settled = false;
    const guard = requireGitHubLakeCallbackSession(callbackLocation).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    finishBootstrap();
    await guard;
    expect(settled).toBe(true);
  });

  it('sends a visitor with no session to /login and back with the query GitHub sent', async () => {
    getState.mockReturnValue({ currentUser: null });

    const error = await thrownBy(requireGitHubLakeCallbackSession(callbackLocation));

    expect(isRedirect(error)).toBe(true);
    expect((error as { options: { to: string; search: unknown } }).options).toMatchObject({
      to: '/login',
      search: { redirectTo: '/data-lakes/github/callback?installation_id=42&code=c1&state=s1' },
    });
  });

  it('falls back to the router query when no boot snapshot exists', async () => {
    getState.mockReturnValue({ currentUser: null });
    getBootSearch.mockReturnValue(null);

    const error = await thrownBy(requireGitHubLakeCallbackSession(callbackLocation));

    expect((error as { options: { search: { redirectTo: string } } }).options.search.redirectTo).toBe(
      '/data-lakes/github/callback?installation_id=%2242%22&code=c1&state=s1'
    );
  });
});
