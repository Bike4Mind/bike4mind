import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { mockLoadRedditPixel, mockLoadMetaPixel } = vi.hoisted(() => ({
  mockLoadRedditPixel: vi.fn(),
  mockLoadMetaPixel: vi.fn(),
}));

vi.mock('@client/app/utils/redditPixel', () => ({
  loadRedditPixel: mockLoadRedditPixel,
}));

vi.mock('@client/app/utils/metaPixel', () => ({
  loadMetaPixel: mockLoadMetaPixel,
}));

import { CookieConsentBanner } from './CookieConsentBanner';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

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

function clearCookies() {
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) document.cookie = `${name}=; max-age=0`;
  }
}

/** Signals the marketing site pins to the parent domain. */
function setRegion(region: 'eu' | 'row') {
  document.cookie = `b4m-region=${region}`;
}

function setSharedDecision(decision: 'granted' | 'denied') {
  document.cookie = `b4m-consent-decision=${decision}`;
}

describe('CookieConsentBanner', () => {
  beforeEach(() => {
    localStorageMock.clear();
    mockGtag.mockClear();
    mockLoadRedditPixel.mockClear();
    mockLoadMetaPixel.mockClear();
    clearCookies();
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

  it('loads both ad pixels on Accept but neither on Decline', () => {
    const { unmount } = render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('cookie-consent-accept-btn'));
    expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
    expect(mockLoadMetaPixel).toHaveBeenCalledTimes(1);
    unmount();

    mockLoadRedditPixel.mockClear();
    mockLoadMetaPixel.mockClear();
    localStorageMock.clear();
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));
    expect(mockLoadRedditPixel).not.toHaveBeenCalled();
    expect(mockLoadMetaPixel).not.toHaveBeenCalled();
  });

  it('loads both ad pixels on mount when consent was previously granted', () => {
    localStorageMock.setItem('cookie_consent', 'granted');

    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
    expect(mockLoadMetaPixel).toHaveBeenCalledTimes(1);
  });

  // The case the gate exists for: the marketing site showed this visitor nothing,
  // so a banner here would be one journey asking twice.
  describe('outside the opt-in region', () => {
    it('shows no banner and grants by default', () => {
      setRegion('row');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'granted' });
      expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
    });

    // Auto-allow is a fact about where the visitor is, not a decision they
    // made: persisting it would freeze the answer for someone who travels.
    it('does not record the auto-allow as a stored decision', () => {
      setRegion('row');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(localStorageMock.getItem('cookie_consent')).toBeNull();
    });

    it('still honors an explicit decline', () => {
      setRegion('row');
      localStorageMock.setItem('cookie_consent', 'denied');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
      expect(mockLoadRedditPixel).not.toHaveBeenCalled();
    });
  });

  // A decision made on the marketing site is this visitor's decision. Nothing in this
  // app can see that origin's localStorage, so without the shared cookie a Decline there
  // was invisible here and the region auto-granted over the top of it.
  describe('a decision made on the marketing site', () => {
    it('is honored over a region that would otherwise auto-grant', () => {
      setRegion('row');
      setSharedDecision('denied');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
      expect(mockLoadRedditPixel).not.toHaveBeenCalled();
      expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
    });

    it('carries an acceptance across without asking again', () => {
      setRegion('eu');
      setSharedDecision('granted');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'granted' });
      expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
    });

    it('loses to a decision made here, whichever way each one went', () => {
      setSharedDecision('granted');
      localStorageMock.setItem('cookie_consent', 'denied');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
      expect(mockLoadRedditPixel).not.toHaveBeenCalled();
    });

    // It is a signal about the visitor, not a decision they took on this origin;
    // persisting it would outlive the decision it mirrors.
    it('is not copied into this origin as a stored decision', () => {
      setSharedDecision('granted');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(localStorageMock.getItem('cookie_consent')).toBeNull();
    });

    // Falling through to the region is the safe read; treating it as consent is not.
    it('falls through to the region when the cookie is unrecognized', () => {
      setRegion('eu');
      document.cookie = 'b4m-consent-decision=maybe';

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(screen.getByTestId('cookie-consent-accept-btn')).toBeInTheDocument();
      expect(mockGtag).not.toHaveBeenCalled();
    });
  });

  describe('inside the opt-in region', () => {
    it('shows the banner and grants nothing up front', () => {
      setRegion('eu');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(screen.getByTestId('cookie-consent-accept-btn')).toBeInTheDocument();
      expect(mockGtag).not.toHaveBeenCalled();
      expect(mockLoadRedditPixel).not.toHaveBeenCalled();
    });
  });

  // A fork, or any deployment with no marketing site in front of it, never
  // sees the cookie. Unknown has to mean "ask".
  it('shows the banner when no region cookie is present', () => {
    render(
      <TestWrapper>
        <CookieConsentBanner />
      </TestWrapper>
    );

    expect(screen.getByTestId('cookie-consent-accept-btn')).toBeInTheDocument();
    expect(mockLoadRedditPixel).not.toHaveBeenCalled();
  });
});
