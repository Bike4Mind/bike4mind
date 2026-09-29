import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

import { CookieConsentBanner, useCookieSettings } from './CookieConsentBanner';
import { captureUtmParams, flushUtmCapture } from '../utils/utmCapture';

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
    useCookieSettings.setState({ isOpen: false });
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
      expect(mockLoadMetaPixel).toHaveBeenCalledTimes(1);
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
      expect(mockLoadMetaPixel).not.toHaveBeenCalled();
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
      expect(mockLoadMetaPixel).not.toHaveBeenCalled();
      expect(screen.queryByTestId('cookie-consent-accept-btn')).not.toBeInTheDocument();
    });

    it('flushes a held landing campaign when Accept is clicked after the URL has changed', () => {
      window.history.replaceState({}, '', '/?utm_source=newsletter');
      captureUtmParams();
      window.history.replaceState({}, '', '/');
      expect(document.cookie).not.toContain('b4m_last_touch=');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('cookie-consent-accept-btn'));

      expect(document.cookie).toContain('b4m_last_touch=%7B%22source%22%3A%22newsletter%22%7D');
      expect(document.cookie).toContain('b4m_app_first_touch=%7B%22source%22%3A%22newsletter%22%7D');
    });

    it('discards a held landing campaign on Decline so a later grant cannot flush it', () => {
      window.history.replaceState({}, '', '/?utm_source=newsletter');
      captureUtmParams();
      window.history.replaceState({}, '', '/');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );
      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));
      localStorageMock.setItem('cookie_consent', 'granted');
      flushUtmCapture();

      expect(document.cookie).not.toContain('b4m_last_touch=');
      expect(document.cookie).not.toContain('b4m_app_first_touch=');
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
      expect(mockLoadMetaPixel).toHaveBeenCalledTimes(1);
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
      expect(mockLoadMetaPixel).not.toHaveBeenCalled();
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
      expect(mockLoadMetaPixel).not.toHaveBeenCalled();
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
    expect(mockLoadMetaPixel).not.toHaveBeenCalled();
  });

  // A later decline has to actually stop checkout from copying stale attribution
  // into Stripe, not just gate new pixel loads.
  describe('clearing attribution cookies on a later decline', () => {
    function setAttributionCookies() {
      document.cookie = 'b4m_utm=%7B%22source%22%3A%22newsletter%22%7D; path=/';
      document.cookie = 'b4m_last_touch=%7B%22source%22%3A%22newsletter%22%7D; path=/';
      document.cookie = 'b4m_app_first_touch=%7B%22source%22%3A%22newsletter%22%7D; path=/';
    }

    function attributionCookiesPresent(): boolean {
      return ['b4m_utm', 'b4m_last_touch', 'b4m_app_first_touch'].some(name =>
        document.cookie.split('; ').some(c => c.startsWith(`${name}=`))
      );
    }

    it('expires held attribution cookies when this origin already decided denied', () => {
      setAttributionCookies();
      localStorageMock.setItem('cookie_consent', 'denied');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(attributionCookiesPresent()).toBe(false);
    });

    it('expires held attribution cookies when the marketing site decided denied', () => {
      setAttributionCookies();
      setSharedDecision('denied');

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      expect(attributionCookiesPresent()).toBe(false);
    });

    it('expires held attribution cookies on a Decline click', () => {
      setAttributionCookies();

      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );

      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

      expect(attributionCookiesPresent()).toBe(false);
    });
  });
  // Withdrawing consent has to be as easy as giving it, so a decision made once must be
  // reachable again - from the profile menu or the login footer, both via this store.
  describe('reopened from Cookie settings', () => {
    const originalLocation = window.location;
    const reload = vi.fn();

    beforeEach(() => {
      reload.mockClear();
      // jsdom's location.reload is non-configurable, so spyOn cannot wrap it.
      Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    const renderAndReopen = () => {
      render(
        <TestWrapper>
          <CookieConsentBanner />
        </TestWrapper>
      );
      act(() => useCookieSettings.getState().open());
    };

    it('shows a manage screen with the choice in force, not the first-run ask', () => {
      localStorageMock.setItem('cookie_consent', 'granted');

      renderAndReopen();

      expect(screen.getByText('Cookie settings.')).toBeInTheDocument();
      expect(screen.getByTestId('cookie-consent-banner')).toHaveTextContent(
        'You are currently allowing campaign attribution cookies.'
      );
      expect(screen.getByTestId('cookie-consent-banner')).toHaveTextContent('Declining reloads the page');
      expect(screen.getByTestId('cookie-consent-cancel-btn')).toBeInTheDocument();
      expect(screen.queryByText(/By clicking/)).not.toBeInTheDocument();
    });

    it('withdraws a grant: stores the decline, tells gtag, and reloads so the pixels unload', () => {
      localStorageMock.setItem('cookie_consent', 'granted');
      renderAndReopen();
      mockGtag.mockClear();

      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

      expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
      expect(mockGtag).toHaveBeenCalledWith('consent', 'update', { analytics_storage: 'denied' });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('cookie-consent-banner')).not.toBeInTheDocument();
      expect(useCookieSettings.getState().isOpen).toBe(false);
    });

    it('clears attribution when a grant is withdrawn without configured trackers', () => {
      for (const name of [
        'NEXT_PUBLIC_GA_MEASUREMENT_ID',
        'NEXT_PUBLIC_REDDIT_PIXEL_ID',
        'NEXT_PUBLIC_META_PIXEL_ID',
      ]) {
        vi.stubEnv(name, '');
      }
      try {
        localStorageMock.setItem('cookie_consent', 'granted');
        const cookieNames = ['b4m_utm', 'b4m_last_touch', 'b4m_app_first_touch'];
        for (const name of cookieNames) document.cookie = `${name}=campaign; path=/`;
        renderAndReopen();

        fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

        expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
        for (const name of cookieNames) expect(document.cookie).not.toContain(`${name}=`);
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('grants over a decline live, with no reload', () => {
      localStorageMock.setItem('cookie_consent', 'denied');
      renderAndReopen();

      expect(screen.getByTestId('cookie-consent-banner')).toHaveTextContent(
        'You are currently declining campaign attribution cookies.'
      );
      expect(screen.getByTestId('cookie-consent-banner')).not.toHaveTextContent('reloads the page');

      fireEvent.click(screen.getByTestId('cookie-consent-accept-btn'));

      expect(localStorageMock.getItem('cookie_consent')).toBe('granted');
      expect(mockLoadRedditPixel).toHaveBeenCalledTimes(1);
      expect(mockLoadMetaPixel).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    });

    it('does not reload when the choice withdraws nothing', () => {
      localStorageMock.setItem('cookie_consent', 'denied');
      renderAndReopen();

      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

      expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
      expect(reload).not.toHaveBeenCalled();
    });

    // The visitors the region gate never asks. Before this they had no way to decline at all.
    it('lets a visitor auto-allowed by region decline', () => {
      setRegion('row');
      renderAndReopen();

      expect(screen.getByTestId('cookie-consent-banner')).toHaveTextContent('You are currently allowing');

      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

      expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    // Reported as the marketing site's decision, but a choice here is recorded here and outranks it.
    it('overrides a grant carried over from the marketing site', () => {
      setSharedDecision('granted');
      renderAndReopen();

      fireEvent.click(screen.getByTestId('cookie-consent-decline-btn'));

      expect(localStorageMock.getItem('cookie_consent')).toBe('denied');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('Cancel closes it and changes nothing', () => {
      localStorageMock.setItem('cookie_consent', 'granted');
      renderAndReopen();
      mockGtag.mockClear();
      mockLoadRedditPixel.mockClear();
      mockLoadMetaPixel.mockClear();

      fireEvent.click(screen.getByTestId('cookie-consent-cancel-btn'));

      expect(screen.queryByTestId('cookie-consent-banner')).not.toBeInTheDocument();
      expect(useCookieSettings.getState().isOpen).toBe(false);
      expect(localStorageMock.getItem('cookie_consent')).toBe('granted');
      expect(mockGtag).not.toHaveBeenCalled();
      expect(mockLoadRedditPixel).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('stays the first-run ask when there is no decision to manage yet', () => {
      renderAndReopen();

      expect(screen.getByText(/By clicking/)).toBeInTheDocument();
      expect(screen.queryByText('Cookie settings.')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cookie-consent-cancel-btn')).not.toBeInTheDocument();
    });
  });
});
