import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRedirect } from '@tanstack/react-router';
import {
  captureMcpOAuthCallbackSearch,
  getMcpOAuthCallbackBootSearch,
  requireMcpOAuthCallbackSession,
} from '@client/app/utils/mcpOAuthCallback';

const { bootstrapSession, getState } = vi.hoisted(() => ({ bootstrapSession: vi.fn(), getState: vi.fn() }));

vi.mock('@client/app/utils/sessionBootstrap', () => ({ bootstrapSession }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: { getState } }));

const location = { pathname: '/integrations/mcp-oauth-callback', searchStr: '?code=%22123%22&state=s1' };

describe('requireMcpOAuthCallbackSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapSession.mockResolvedValue(undefined);
    window.history.pushState({}, '', '/integrations/mcp-oauth-callback?code=123&state=s1');
    captureMcpOAuthCallbackSearch();
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
    captureMcpOAuthCallbackSearch();
  });

  it('snapshots the raw query only on the callback path', () => {
    expect(getMcpOAuthCallbackBootSearch()).toBe('?code=123&state=s1');
    window.history.pushState({}, '', '/elsewhere?code=1');
    captureMcpOAuthCallbackSearch();
    expect(getMcpOAuthCallbackBootSearch()).toBeNull();
  });

  it('waits for the session bootstrap and lets a signed-in user through', async () => {
    getState.mockReturnValue({ currentUser: { id: 'u1' } });
    await expect(requireMcpOAuthCallbackSession(location)).resolves.toBeUndefined();
    expect(bootstrapSession).toHaveBeenCalledTimes(1);
  });

  it('sends a signed-out user to /login and back with the query as the server sent it', async () => {
    getState.mockReturnValue({ currentUser: null });
    const error = await requireMcpOAuthCallbackSession(location).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isRedirect(error)).toBe(true);
    expect((error as { options: { to: string; search: unknown } }).options).toMatchObject({
      to: '/login',
      search: { redirectTo: '/integrations/mcp-oauth-callback?code=123&state=s1' },
    });
  });
});
