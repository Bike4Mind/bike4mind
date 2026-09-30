import React from 'react';
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
  Link: ({ children, search, ...props }: { children: React.ReactNode; search?: unknown; [key: string]: unknown }) => (
    <a
      {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
      data-search={search !== undefined ? JSON.stringify(search) : undefined}
    >
      {children}
    </a>
  ),
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

const MODES = ['light', 'dark'] as const;
const WCAG_AA_NORMAL_TEXT = 4.5;

const parseColor = (color: string): [number, number, number, number] => {
  const fn = color.match(/rgba?\(([^)]+)\)/);
  if (fn) {
    const parts = fn[1].split(',').map(part => parseFloat(part.trim()));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const hex = color.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
};

// Both text tokens here are alpha-blended over the card, so flatten before measuring.
const relativeLuminance = (color: string, backdrop: string) => {
  const [r, g, b, a] = parseColor(color);
  const [br, bg, bb] = parseColor(backdrop);
  const channel = (value: number, base: number) => {
    const blended = (value * a + base * (1 - a)) / 255;
    return blended <= 0.03928 ? blended / 12.92 : Math.pow((blended + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r, br) + 0.7152 * channel(g, bg) + 0.0722 * channel(b, bb);
};

/**
 * WCAG 2.1 contrast of a text token against the consent card. The card is the outlined Sheet, which
 * Joy paints with background.surface - confirmed against the live preview, which measured #F4F7F9.
 */
const contrastOnCard = (mode: (typeof MODES)[number], token: 'primary' | 'tertiary') => {
  const palette = appTheme.colorSchemes[mode].palette;
  const card = palette.background.surface;
  const text = relativeLuminance(palette.text[token], card);
  const surface = relativeLuminance(card, card);
  const [lighter, darker] = text > surface ? [text, surface] : [surface, text];
  return (lighter + 0.05) / (darker + 0.05);
};

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

  it('renders the revoke-hint link pointing to Settings > Security > Approved Apps', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid'] }),
    });

    renderPage();

    await screen.findByTestId('oauth-consent-scopes');
    const hint = screen.getByTestId('oauth-consent-revoke-hint-link');
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveAttribute('to', '/profile');
    expect(hint).toHaveAttribute('data-search', JSON.stringify({ tab: 'settings', section: 'security' }));
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

describe('OAuthAuthorizePage scope label readability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = { client_id: 'client-1', redirect_uri: REDIRECT, response_type: 'code' };
  });

  it('gives the plain-language label an explicit colour instead of the dim body-sm default', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ consent_required: true, client_name: 'VibesWire', scopes: ['openid'] }),
    });

    renderPage();

    // Joy resolves body-sm to text.tertiary. Shipping that default made the explanation the least
    // readable text on the card, dimmer than the raw id beneath it, so the token is pinned here.
    const label = await screen.findByTestId('oauth-consent-scope-label');
    const color = getComputedStyle(label).color;
    expect(color).toContain('text-primary');
    expect(color).not.toContain('text-tertiary');
  });

  it.each(MODES)('%s: the label clears WCAG AA against the consent card', mode => {
    expect(contrastOnCard(mode, 'primary')).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it('gives the authorization-failure message a readable colour too', async () => {
    // Pre-existing, outside this PR's original diff, but the identical defect in the same file:
    // an unreadable error is worse than an unreadable label, so it is fixed alongside.
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: 'invalid_client', error_description: 'Unknown client' }),
    });

    renderPage();

    const message = await screen.findByTestId('oauth-error-message');
    expect(message).toHaveTextContent('Unknown client');
    expect(getComputedStyle(message).color).toContain('text-primary');
  });

  it.each(MODES)('%s: the body-sm default it replaced would not have cleared AA', mode => {
    // Positive control. Without it the assertion above could pass against any token and prove
    // nothing. These reproduce the ratios measured on the preview: 2.23 light, 4.35 dark.
    expect(contrastOnCard(mode, 'tertiary')).toBeLessThan(WCAG_AA_NORMAL_TEXT);
  });
});
