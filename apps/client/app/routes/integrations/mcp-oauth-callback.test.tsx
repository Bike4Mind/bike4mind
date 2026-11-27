import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  navigate: vi.fn(),
  boot: null as string | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}));

vi.mock('@client/app/utils/mcpOAuthCallback', () => ({
  getMcpOAuthCallbackBootSearch: () => h.boot,
  clearMcpOAuthCallbackBootSearch: () => {
    h.boot = null;
  },
}));

import McpOAuthCallbackPage from './mcp-oauth-callback';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <McpOAuthCallbackPage />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.post.mockReset().mockResolvedValue({ data: {} });
  h.navigate.mockReset();
  h.boot = null;
  window.history.replaceState(null, '', '/');
});

describe('McpOAuthCallbackPage', () => {
  it('posts the one-time parameters once and returns to Integrations', async () => {
    h.boot = '?code=c1&state=post-s1&iss=https%3A%2F%2Fauth.example.com';
    renderPage();
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { tab: 'integrations' }, replace: true })
    );
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('/api/mcp-connections/oauth/callback', {
      code: 'c1',
      state: 'post-s1',
      iss: 'https://auth.example.com',
    });
  });

  it('posts the code exactly as the server sent it when it is all digits', async () => {
    h.boot = '?code=0123456789012345678&state=digits-s1';
    renderPage();
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(h.post).toHaveBeenCalledWith('/api/mcp-connections/oauth/callback', {
      code: '0123456789012345678',
      state: 'digits-s1',
      iss: undefined,
    });
  });

  it('reads the raw address-bar query when there is no boot snapshot (after an SSO login)', async () => {
    window.history.replaceState(null, '', '/integrations/mcp-oauth-callback?code=987654321&state=sso-s1');
    renderPage();
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(h.post).toHaveBeenCalledWith('/api/mcp-connections/oauth/callback', {
      code: '987654321',
      state: 'sso-s1',
      iss: undefined,
    });
  });

  it('does not post the spent code again when Back remounts the page at the callback URL', async () => {
    h.boot = '?code=c1&state=spent-s1';
    const first = renderPage();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1));
    first.unmount();
    // After a login hop there is no snapshot; the address bar still holds the spent query.
    window.history.replaceState(null, '', '/integrations/mcp-oauth-callback?code=c1&state=spent-s1');
    renderPage();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(2));
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: '/integrations',
      search: { tab: 'integrations' },
      replace: true,
    });
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('does not show a failure when the exchange worked but navigation rejects', async () => {
    h.boot = '?code=c1&state=nav-s1';
    h.navigate.mockRejectedValueOnce(new Error('navigation failed'));
    renderPage();
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByTestId('mcp-oauth-callback-error')).not.toBeInTheDocument();
  });

  it('treats a provider error that also carries a code as failed without posting', async () => {
    h.boot = '?error=access_denied&code=c1&state=err-s1';
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('posts once under StrictMode, which runs the effect twice', async () => {
    h.boot = '?code=c1&state=strict-s1';
    render(
      <StrictMode>
        <CssVarsProvider theme={appTheme}>
          <McpOAuthCallbackPage />
        </CssVarsProvider>
      </StrictMode>
    );
    await waitFor(() => expect(h.navigate).toHaveBeenCalled());
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('treats a provider error in the boot query as failed without posting', async () => {
    h.boot = '?error=access_denied&state=s1';
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toBeInTheDocument();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('never renders the provider error text and does not call the API', async () => {
    h.boot = '?error=access_denied&error_description=%3Cb%3EVisit%20evil.example%3C%2Fb%3E';
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toHaveTextContent(
      'Sign-in could not be completed. Please try connecting again.'
    );
    expect(document.body.textContent).not.toContain('evil.example');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('shows the fixed message when the exchange is refused', async () => {
    h.boot = '?code=c1&state=bad';
    h.post.mockRejectedValue(new Error('invalid_state'));
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toBeInTheDocument();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
