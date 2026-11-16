// @vitest-environment jsdom
import React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** Mirrors the route: beforeLoad captures the token, then the page renders. */
async function openLink(url: string) {
  window.history.replaceState(null, '', url);
  const { captureUnsubscribeToken } = await import('./unsubscribeToken');
  captureUnsubscribeToken();
  const { default: UnsubscribePage } = await import('./unsubscribe');
  render(<UnsubscribePage />, { wrapper: TestWrapper });
}

const PREFERENCES = {
  email: 'reader@example.com',
  preferences: { unsubscribedCategories: [], globalUnsubscribe: false },
  categories: [],
};

describe('UnsubscribePage', () => {
  beforeEach(() => {
    api.get.mockReset().mockResolvedValue({ data: PREFERENCES });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ['fragment', '/email/unsubscribe#token=frag-token', 'frag-token'],
    ['legacy query', '/email/unsubscribe?token=query-token', 'query-token'],
  ])('sends the %s token in a header and strips it from the address', async (_form, url, token) => {
    await openLink(url);

    expect(await screen.findByText(/reader@example\.com/)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/api/email/unsubscribe', { headers: { 'x-unsubscribe-token': token } });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/email/unsubscribe');
  });

  it('explains a missing token without calling the API', async () => {
    await openLink('/email/unsubscribe');

    expect(await screen.findByText(/No unsubscribe token provided/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});
