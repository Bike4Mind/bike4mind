import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: vi.fn() }));
vi.mock('@client/app/hooks/useAccessToken', () => ({ useAccessToken: vi.fn() }));

const getMock = vi.fn();
const solveMock = vi.fn();
vi.mock('@client/app/utils/turnstile', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/turnstile')>()),
  getTurnstileToken: (...args: unknown[]) => solveMock(...args),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => getMock(...args), post: () => Promise.resolve() },
}));

import { oauthStartProvider, oauthStartUrl, useStartOAuthSignIn } from './auth';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
};

const location = { href: '', search: '' };

beforeEach(() => {
  vi.resetAllMocks();
  getMock.mockResolvedValue({ data: { turnstileSiteKey: '' } });
  location.href = '';
  location.search = '';
  vi.stubGlobal('location', location);
});

async function start(startUrl: string) {
  const { result } = renderHook(() => useStartOAuthSignIn(), { wrapper });
  return result.current(startUrl);
}

describe('oauthStartProvider', () => {
  it.each([
    ['/api/auth/google', 'google'],
    ['/api/auth/github/', 'github'],
    ['/api/auth/okta?idp=abc', 'okta'],
    ['/api/auth/saml?idp=abc', 'saml'],
    ['/api/auth/google/callback', undefined],
    ['/login', undefined],
  ])('reads %s as %j', (url, provider) => {
    expect(oauthStartProvider(url)).toBe(provider);
  });
});

describe('oauthStartUrl', () => {
  it('keeps redirectTo and the token out of each other', () => {
    expect(oauthStartUrl('/api/auth/okta?idp=abc', '/chat?x=1', undefined)).toBe(
      '/api/auth/okta?idp=abc&redirectTo=%2Fchat%3Fx%3D1'
    );
    expect(oauthStartUrl('/api/auth/google', null, 'tok')).toBe('/api/auth/google?turnstileToken=tok');
  });
});

describe('useStartOAuthSignIn', () => {
  it('navigates unchanged when the stage does not enforce the challenge', async () => {
    await start('/api/auth/google');
    expect(solveMock).not.toHaveBeenCalled();
    expect(location.href).toBe('/api/auth/google');
  });

  it.each(['google', 'github'])('solves the oauth-start challenge for %s and carries the token', async provider => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockResolvedValue('tok');
    location.search = '?redirectTo=%2Fchat';
    await start(`/api/auth/${provider}`);
    expect(solveMock).toHaveBeenCalledWith('site', 'oauth-start');
    expect(location.href).toBe(`/api/auth/${provider}?redirectTo=%2Fchat&turnstileToken=tok`);
  });

  it('never challenges enterprise SSO even while the policy is on', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    await start('/api/auth/okta?idp=abc');
    expect(solveMock).not.toHaveBeenCalled();
    expect(location.href).toBe('/api/auth/okta?idp=abc');
  });

  it('rejects without navigating when the challenge cannot be completed', async () => {
    getMock.mockResolvedValue({ data: { turnstileSiteKey: 'site' } });
    solveMock.mockRejectedValue(new Error('turnstile-unavailable'));
    await expect(start('/api/auth/google')).rejects.toThrow(/verification check/i);
    expect(location.href).toBe('');
  });
});
