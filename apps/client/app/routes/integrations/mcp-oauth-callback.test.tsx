import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useSearch: () => h.search,
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
  h.search = {};
});

describe('McpOAuthCallbackPage', () => {
  it('posts the one-time parameters once and returns to Integrations', async () => {
    h.search = { code: 'c1', state: 's1', iss: 'https://auth.example.com' };
    renderPage();
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { tab: 'integrations' } })
    );
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('/api/mcp-connections/oauth/callback', {
      code: 'c1',
      state: 's1',
      iss: 'https://auth.example.com',
    });
  });

  it('never renders the provider error text and does not call the API', async () => {
    h.search = { error: 'access_denied', error_description: '<b>Visit evil.example</b>' };
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toHaveTextContent(
      'Sign-in could not be completed. Please try connecting again.'
    );
    expect(document.body.textContent).not.toContain('evil.example');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('shows the fixed message when the exchange is refused', async () => {
    h.search = { code: 'c1', state: 'bad' };
    h.post.mockRejectedValue(new Error('invalid_state'));
    renderPage();
    expect(await screen.findByTestId('mcp-oauth-callback-error')).toBeInTheDocument();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
