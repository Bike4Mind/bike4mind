// @vitest-environment jsdom
import React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { EmailCategory } from '@bike4mind/common';

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

const PREFERENCES_WITH_CATEGORY = { ...PREFERENCES, categories: [EmailCategory.MARKETING] };

const LOAD_FALLBACK = 'Failed to load preferences. The link may be invalid or expired.';
const UPDATE_FALLBACK = 'Failed to update preferences';

/** getServerErrorField reads this through axios's own isAxiosError guard, so the flag is required. */
const serverRejection = (data: Record<string, unknown>, status = 400) => ({
  isAxiosError: true,
  response: { status, data },
});

/** The shared envelope the API sends for a thrown BadRequestError: the reason is in `error`. */
const envelope = (error: string) => ({ name: 'BadRequestError', error });

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

  describe('when loading the preferences fails', () => {
    it("shows the server's reason from the error envelope", async () => {
      api.get.mockRejectedValue(serverRejection(envelope('Invalid or expired token')));

      await openLink('/email/unsubscribe#token=bad-token');

      expect(await screen.findByText('Invalid or expired token')).toBeTruthy();
      expect(screen.queryByText(LOAD_FALLBACK)).toBeNull();
    });

    it.each([
      ['has no error field', serverRejection({ name: 'InternalServerError' }, 500)],
      ['has a non-string error field', serverRejection({ error: { code: 7 } }, 500)],
      ['never got a response', { isAxiosError: true, message: 'Network Error' }],
      ['is not an axios error', new Error('boom')],
    ])('keeps the generic text when the failure %s', async (_case, rejection) => {
      api.get.mockRejectedValue(rejection);

      await openLink('/email/unsubscribe#token=bad-token');

      expect(await screen.findByText(LOAD_FALLBACK)).toBeTruthy();
    });
  });

  describe('when an update fails', () => {
    beforeEach(() => {
      api.get.mockReset().mockResolvedValue({ data: PREFERENCES_WITH_CATEGORY });
      api.post.mockReset();
    });

    it("shows the server's reason when unsubscribing from one category fails", async () => {
      api.post.mockRejectedValue(serverRejection(envelope('Category cannot be changed')));
      await openLink('/email/unsubscribe#token=good-token');

      fireEvent.click(await screen.findByTestId('unsubscribe-marketing'));

      expect(await screen.findByText('Category cannot be changed')).toBeTruthy();
      expect(screen.queryByText(UPDATE_FALLBACK)).toBeNull();
      expect(api.post).toHaveBeenCalledWith(
        '/api/email/unsubscribe',
        { category: EmailCategory.MARKETING },
        { headers: { 'x-unsubscribe-token': 'good-token' } }
      );
    });

    it("shows the server's reason when unsubscribing from everything fails", async () => {
      api.post.mockRejectedValue(serverRejection(envelope('Token already used')));
      await openLink('/email/unsubscribe#token=good-token');

      fireEvent.click(await screen.findByTestId('global-unsubscribe'));

      expect(await screen.findByText('Token already used')).toBeTruthy();
      expect(screen.queryByText(UPDATE_FALLBACK)).toBeNull();
      expect(api.post).toHaveBeenCalledWith(
        '/api/email/unsubscribe',
        { globalUnsubscribe: true },
        { headers: { 'x-unsubscribe-token': 'good-token' } }
      );
    });

    it.each([
      [
        'unsubscribe-marketing',
        'a response with no error field',
        serverRejection({ name: 'InternalServerError' }, 500),
      ],
      ['unsubscribe-marketing', 'a non-axios error', new Error('boom')],
      ['global-unsubscribe', 'a response with no error field', serverRejection({ name: 'InternalServerError' }, 500)],
      ['global-unsubscribe', 'a non-axios error', new Error('boom')],
    ])('keeps the generic text when %s fails with %s', async (testId, _case, rejection) => {
      api.post.mockRejectedValue(rejection);
      await openLink('/email/unsubscribe#token=good-token');

      fireEvent.click(await screen.findByTestId(testId));

      expect(await screen.findByText(UPDATE_FALLBACK)).toBeTruthy();
    });

    it("still shows the server's success message", async () => {
      api.post.mockResolvedValue({
        data: { success: true, message: 'You have been unsubscribed from marketing emails' },
      });
      await openLink('/email/unsubscribe#token=good-token');

      fireEvent.click(await screen.findByTestId('unsubscribe-marketing'));

      expect(await screen.findByText('You have been unsubscribed from marketing emails')).toBeTruthy();
      await waitFor(() => expect(screen.queryByTestId('unsubscribe-marketing')).toBeNull());
    });
  });
});
