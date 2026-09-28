import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockNavigate = vi.fn();
let searchParams: Record<string, string | undefined>;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => searchParams,
}));

vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: () => ({ accessToken: 'tok', resetTokens: vi.fn() }),
}));

// The branded header reaches react-query through useLogoSettings/useConfig, which this suite
// does not stand up a QueryClientProvider for. The logo is not what any case here asserts.
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));

import OAuthAuthorizePage from './authorize';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPage = () => render(<OAuthAuthorizePage />, { wrapper: TestWrapper });

const REDIRECT = 'https://app.example/cb';

describe('OAuthAuthorizePage consent screen', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = {
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email ai:generate',
      state: 'xyz-state',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    };
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '', pathname: '/oauth/authorize', search: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  // First /code call yields consent_required; the second (Allow) yields a code.
  const primeConsentThenCode = () => {
    (global.fetch as unknown as Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid', 'ai:generate'] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 'the-code' }),
      });
  };

  it('renders the consent screen listing each requested scope', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid', 'ai:generate'] }),
    });

    renderPage();

    expect(await screen.findByText('Authorize VibesWire')).toBeInTheDocument();
    const list = screen.getByTestId('oauth-consent-scopes');
    expect(list).toHaveTextContent('openid');
    expect(list).toHaveTextContent('ai:generate');
    expect(screen.getByTestId('oauth-consent-allow-btn')).toBeInTheDocument();
    expect(screen.getByTestId('oauth-consent-deny-btn')).toBeInTheDocument();
  });

  it('shows a plain-language label with the raw scope id kept beside it', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid'] }),
    });

    renderPage();

    const list = await screen.findByTestId('oauth-consent-scopes');
    expect(list).toHaveTextContent('Confirm who you are');
    // The id stays on screen: the wording is an aid, not a replacement for what is granted.
    // Deliberately a scope whose id is NOT a substring of its label - asserting on 'email'
    // against 'See your email address' would pass even with the id removed.
    expect(list).toHaveTextContent('openid');
  });

  it('still renders a scope it has no label for, rather than dropping it', async () => {
    // The server validates scopes against the client registration, not against the label map, so
    // a newly registered scope arrives unmapped. Hiding it would show the user fewer permissions
    // than the client actually receives.
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid', 'billing:write'] }),
    });

    renderPage();

    await screen.findByTestId('oauth-consent-scopes');
    expect(screen.getAllByTestId('oauth-consent-scope')).toHaveLength(2);
    expect(screen.getByTestId('oauth-consent-scopes')).toHaveTextContent('billing:write');
  });

  it('on Allow, re-requests with consent and redirects to the client with the code and preserved state', async () => {
    global.fetch = vi.fn();
    primeConsentThenCode();

    renderPage();

    const allow = await screen.findByTestId('oauth-consent-allow-btn');
    fireEvent.click(allow);

    await waitFor(() => expect(window.location.href).not.toBe(''));

    // Second call carried consent: true.
    const secondBody = JSON.parse((global.fetch as unknown as Mock).mock.calls[1][1].body);
    expect(secondBody.consent).toBe(true);

    const url = new URL(window.location.href);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state')).toBe('xyz-state');
  });

  it('on Deny, redirects to the client with error=access_denied and preserved state, minting nothing', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid', 'ai:generate'] }),
    });

    renderPage();

    const deny = await screen.findByTestId('oauth-consent-deny-btn');
    fireEvent.click(deny);

    const url = new URL(window.location.href);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('code')).toBeNull();
    // Deny does not call /code again.
    expect((global.fetch as unknown as Mock).mock.calls).toHaveLength(1);
  });
});
