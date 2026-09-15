import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { mockLoadRedditPixel } = vi.hoisted(() => ({
  mockLoadRedditPixel: vi.fn(),
}));

vi.mock('@client/app/utils/redditPixel', () => ({
  loadRedditPixel: mockLoadRedditPixel,
}));

import { CookieConsentBanner } from './CookieConsentBanner';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

// Mock gtag global
const mockGtag = vi.fn();
vi.stubGlobal('gtag', mockGtag);

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

describe('CookieConsentBanner', () => {
  beforeEach(() => {
    localStorageMock.clear();
    mockGtag.mockClear();
    mockLoadRedditPixel.mockClear();
  });

  it('shows banner when no consent is stored', () => {
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(screen.getByTestId('cookie-consent-accept-btn')).toBeInTheDocument();
    expect(screen.getByTestId('cookie-consent-decline-btn')).toBeInTheDocument();
  });

  it('hides banner when consent was previously granted', () => {
    localStorageMock.setItem('cookie_consent', 'granted');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
  });

  it('hides banner when consent was previously denied', () => {
    localStorageMock.setItem('cookie_consent', 'denied');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
  });

  it('restores granted consent via gtag on page load', () => {
    localStorageMock.setItem('cookie_consent', 'granted');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'granted' });
  });

  it('restores denied consent via gtag on page load', () => {
    localStorageMock.setItem('cookie_consent', 'denied');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
  });

  it('grants consent and hides banner on Accept click', () => {
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('cookie-consent-accept-btn'));

    expect(localStorageMock.getItem('cookie_consent')).toBe('granted');
    expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'granted' });
    expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
  });

  it('denies consent and hides banner on Decline click', () => {
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

    expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
    expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
    expect(screen.queryByTestId('cookie-consent-decline-btn')).not.toBeInTheDocument();
  });

  it('loads the Reddit pixel on Accept but not on Decline', () => {
    const { unmount } = render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('cookie-consent-accept-btn'));
    expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
    unmount();

    mockLoadRedditPixel.mockClear();
    localStorageMock.clear();
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));
    expect(mockLoadRedditPixel).not.toHaveBeenCalled();
  });

  it('loads the Reddit pixel on mount when consent was previously granted', () => {
    localStorageMock.setItem('cookie_consent', 'granted');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
  });
});
