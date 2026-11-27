import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, string | undefined>,
  accessToken: 'tok' as string | null,
  resetTokens: vi.fn(),
  setCurrentUser: vi.fn(),
  queryClient: { removeQueries: vi.fn() },
  clearClientSession: vi.fn(),
  resetSessionBootstrap: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useSearch: () => h.search,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => h.queryClient }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: () => ({ accessToken: h.accessToken, resetTokens: h.resetTokens }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ setCurrentUser: h.setCurrentUser }) }));
vi.mock('@client/app/hooks/data/user', () => ({ clearClientSession: h.clearClientSession }));
vi.mock('@client/app/utils/sessionBootstrap', () => ({ resetSessionBootstrap: h.resetSessionBootstrap }));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));

import OAuthLogoutPage from './logout';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const renderPage = () => render(<OAuthLogoutPage />, { wrapper: TestWrapper });

const SIGNED_OUT = 'https://rp.example.test/signed-out';

const respond = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

let fetchMock: Mock;
let replace: Mock;
const originalLocation = window.location;

const sentBody = (call = 0) => JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
const sentHeaders = (call = 0) => (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  h.search = { client_id: 'b4m_example_rp_00000000', post_logout_redirect_uri: SIGNED_OUT, state: 's1' };
  h.accessToken = 'tok';
  h.clearClientSession.mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  replace = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, replace } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('OAuthLogoutPage', () => {
  it('shows an error without calling the server when neither client_id nor id_token_hint is given', () => {
    h.search = { post_logout_redirect_uri: SIGNED_OUT };
    renderPage();
    expect(screen.getByTestId('oauth-logout-error-message').textContent).toMatch(/client_id or id_token_hint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the server with only an id_token_hint', async () => {
    h.search = { id_token_hint: 'hint.jwt', post_logout_redirect_uri: SIGNED_OUT };
    fetchMock.mockResolvedValue(respond(200, { status: 'signed_out', redirect_to: SIGNED_OUT }));
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SIGNED_OUT));
    expect(sentBody()).toEqual({ id_token_hint: 'hint.jwt', post_logout_redirect_uri: SIGNED_OUT });
  });

  it('forwards the query and the Bearer token, then follows the server redirect after clearing the client session', async () => {
    fetchMock.mockResolvedValue(respond(200, { status: 'signed_out', redirect_to: `${SIGNED_OUT}?state=s1` }));
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`${SIGNED_OUT}?state=s1`));
    expect(fetchMock).toHaveBeenCalledWith('/api/oauth/end-session', expect.objectContaining({ method: 'POST' }));
    expect(sentBody()).toEqual({
      client_id: 'b4m_example_rp_00000000',
      post_logout_redirect_uri: SIGNED_OUT,
      state: 's1',
    });
    expect(sentHeaders().Authorization).toBe('Bearer tok');
    expect(h.clearClientSession).toHaveBeenCalledWith({
      setCurrentUser: h.setCurrentUser,
      resetTokens: h.resetTokens,
      queryClient: h.queryClient,
    });
    expect(h.resetSessionBootstrap).toHaveBeenCalled();
  });

  it('sends no Authorization header without a session, and shows the signed-out page without a redirect target', async () => {
    h.accessToken = null;
    h.search = { client_id: 'b4m_example_rp_00000000' };
    fetchMock.mockResolvedValue(respond(200, { status: 'signed_out', redirect_to: null }));
    renderPage();
    expect(await screen.findByText("You're signed out of Bike4Mind")).toBeTruthy();
    expect(sentHeaders().Authorization).toBeUndefined();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('oauth-logout-sign-in-btn'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/login' });
  });

  it('asks for confirmation, then signs out with confirm: true', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(200, { status: 'confirmation_required', client_name: 'Example RP', redirect_to: null })
      )
      .mockResolvedValueOnce(respond(200, { status: 'signed_out', redirect_to: null }));
    renderPage();
    expect(await screen.findByText('Sign out of Bike4Mind?')).toBeTruthy();
    expect(screen.getByTestId('oauth-logout-confirm').textContent).toContain('Example RP');
    expect(h.clearClientSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('oauth-logout-confirm-btn'));
    await screen.findByTestId('oauth-logout-signed-out');
    expect(sentBody(1)).toMatchObject({ confirm: true });
    expect(h.clearClientSession).toHaveBeenCalledOnce();
  });

  it('"Stay signed in" returns to the server-validated target without signing out', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        status: 'confirmation_required',
        client_name: 'Example RP',
        redirect_to: `${SIGNED_OUT}?state=s1`,
      })
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('oauth-logout-stay-btn'));
    expect(replace).toHaveBeenCalledWith(`${SIGNED_OUT}?state=s1`);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.clearClientSession).not.toHaveBeenCalled();
  });

  it('"Stay signed in" without a validated target stays in the app', async () => {
    fetchMock.mockResolvedValue(
      respond(200, { status: 'confirmation_required', client_name: 'Example RP', redirect_to: null })
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('oauth-logout-stay-btn'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    ['error_description', { error: 'invalid_client', error_description: 'Unknown client' }, 'Unknown client'],
    ['error only', { error: 'Forbidden' }, 'Forbidden'],
    ['an empty body', {}, 'Sign-out failed (400)'],
  ])('shows the server error (%s) and never redirects', async (_n, body, message) => {
    fetchMock.mockResolvedValue(respond(400, body));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('oauth-logout-error-message').textContent).toBe(message));
    expect(replace).not.toHaveBeenCalled();
    expect(h.clearClientSession).not.toHaveBeenCalled();
  });

  it('treats an unparseable error body like an empty one', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: () => Promise.reject(new Error('bad json')) });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('oauth-logout-error-message').textContent).toBe('Sign-out failed (502)')
    );
  });

  it.each([
    [new Error('network down'), 'network down'],
    ['not an error', 'Sign-out failed'],
  ])('shows a network failure (%s)', async (thrown, message) => {
    fetchMock.mockRejectedValue(thrown);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('oauth-logout-error-message').textContent).toBe(message));
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows a spinner while the request is in flight and calls the server only once', async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const { rerender } = renderPage();
    expect(screen.getByText('Signing you out...')).toBeTruthy();
    h.search = { ...h.search, client_id: 'b4m_changed_00000000' };
    rerender(<OAuthLogoutPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
