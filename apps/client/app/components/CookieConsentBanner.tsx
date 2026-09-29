'use client';

import { useState, useEffect } from 'react';
import { create } from 'zustand';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadMetaPixel } from '@client/app/utils/metaPixel';
import { loadRedditPixel } from '@client/app/utils/redditPixel';
import { CONSENT_KEY, resolveConsent } from '@client/app/utils/consentRegion';
import { clearAttributionCookies, flushUtmCapture } from '@client/app/utils/utmCapture';

type Consent = 'granted' | 'denied';

declare function gtag(...args: unknown[]): void;

/** Reopens the banner as a manage screen, so a decision can be changed after it was made. */
export const useCookieSettings = create<{ isOpen: boolean; open: () => void; close: () => void }>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

/** Point the trackers at a consent state. Deliberately does not persist it, so an
 * auto-allow is re-derived each load rather than freezing the answer for someone
 * who travels. */
function activateConsent(value: Consent) {
  if (typeof gtag !== 'undefined') {
    gtag('consent', 'update', { analytics_storage: value });
  }
  // The ads pixels have no consent-mode equivalent: granted == load the scripts
  // (until then they only queue in memory), denied == they never load. Each
  // no-ops when its own pixel id is unconfigured.
  if (value === 'granted') {
    loadRedditPixel();
    loadMetaPixel();
    // The campaign this visitor landed on, held unwritten since module load if they were
    // still being asked at the time. No-op once written, or when there was none.
    flushUtmCapture();
  } else {
    clearAttributionCookies();
  }
}

/** Record the visitor's own decision, and apply it. */
function applyConsent(value: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // ignore storage errors
  }
  activateConsent(value);
}

export function CookieConsentBanner() {
  const [asking, setAsking] = useState(false);
  const settingsOpen = useCookieSettings(s => s.isOpen);
  const closeSettings = useCookieSettings(s => s.close);

  useEffect(() => {
    const consent = resolveConsent();
    if (consent === 'unset') {
      setAsking(true);
      return;
    }
    activateConsent(consent);
  }, []);

  if (!asking && !settingsOpen) return null;

  // With nothing in force yet there is nothing to manage, so a reopen shows the first-run ask.
  const current = resolveConsent();
  const managing = settingsOpen && current !== 'unset';
  const cookieKinds =
    process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || process.env.NEXT_PUBLIC_META_PIXEL_ID
      ? 'analytics and advertising'
      : 'analytics';

  const choose = (value: Consent) => {
    applyConsent(value);
    setAsking(false);
    closeSettings();
    // An injected pixel script cannot be unloaded, so a withdrawal only takes effect this
    // session through a reload. gtag honors it live; the ads pixels would keep running.
    if (current === 'granted' && value === 'denied') window.location.reload();
  };

  return (
    <Box
      data-testid="cookie-consent-banner"
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        p: 2,
        bgcolor: 'background.surface',
        borderTop: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        flexWrap: 'wrap',
      }}
    >
      {/* textColor is explicit because a bare body-sm resolves to text.tertiary, which this
          theme defines at 50% alpha - 2.23:1 light and 4.35:1 dark on this surface, under WCAG AA. */}
      <Typography level="body-sm" textColor="text.primary" sx={{ flex: 1, minWidth: 200 }}>
        {managing ? (
          <>
            <Typography component="span" fontWeight="lg" textColor="inherit">
              Cookie settings.
            </Typography>{' '}
            You are currently {current === 'granted' ? 'allowing' : 'declining'} {cookieKinds} cookies.
            {current === 'granted' && ' Declining reloads the page so the change takes effect right away.'}
          </>
        ) : (
          <>
            {/* brand externalized */}
            We use cookies to understand how you use {APP_NAME || 'this app'} and to improve your experience. By
            clicking &ldquo;Accept&rdquo;, you consent to our use of {cookieKinds} cookies.
          </>
        )}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        {managing && (
          <Button
            variant="plain"
            color="neutral"
            size="sm"
            onClick={closeSettings}
            data-testid="cookie-consent-cancel-btn"
          >
            Cancel
          </Button>
        )}
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          onClick={() => choose('denied')}
          data-testid="cookie-consent-decline-btn"
        >
          Decline
        </Button>
        <Button
          variant="solid"
          color="primary"
          size="sm"
          onClick={() => choose('granted')}
          data-testid="cookie-consent-accept-btn"
        >
          Accept
        </Button>
      </Box>
    </Box>
  );
}
