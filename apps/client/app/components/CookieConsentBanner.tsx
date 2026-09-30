'use client';

import { useState, useEffect, useRef } from 'react';
import { create } from 'zustand';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadMetaPixel } from '@client/app/utils/metaPixel';
import { loadRedditPixel } from '@client/app/utils/redditPixel';
import { CONSENT_KEY, publishResolvedConsent, resolveConsent } from '@client/app/utils/consentRegion';
import { clearAttributionCookies, flushUtmCapture } from '@client/app/utils/utmCapture';

type Consent = 'granted' | 'denied';

declare function gtag(...args: unknown[]): void;

/** Reopens the banner as a manage screen, so a decision can be changed after it was made. */
export const useCookieSettings = create<{ isOpen: boolean; open: () => void; close: () => void }>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

/** Point the trackers at a consent state. Deliberately does not persist it as a DECISION, so
 * an auto-allow is re-derived each load rather than freezing the answer for someone who
 * travels. The cookie published below is not that: it caches the resolution this load reached
 * so the server can read it, is rewritten every load, and is cleared when the resolution goes
 * back to 'unset' - see publishResolvedConsent. */
function activateConsent(value: Consent) {
  // Before the trackers, so a handler that beats them still sees the right answer. The server
  // cannot read localStorage, and an OAuth signup is credited by a request, not by this page.
  // This is also what carries a later withdrawal (Cookie settings -> Decline) to the server.
  publishResolvedConsent(value);

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
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const consent = resolveConsent();
    if (consent === 'unset') {
      // No decision anywhere: withdraw any cookie a previous load published, so a visitor who
      // carried an auto-allow into the opt-in region is suppressed server-side while they are
      // being asked here, rather than attributed off a resolution that no longer holds.
      publishResolvedConsent('unset');
      setAsking(true);
      return;
    }
    activateConsent(consent);
  }, []);

  // Both triggers sit after the banner in the tab order, so opening it on purpose moves focus
  // into it and closing it hands focus back. Keyed on the request, not the mount, so the
  // unprompted first-run ask never takes focus.
  useEffect(() => {
    if (settingsOpen) {
      // From the profile menu this is body: the menu has already unmounted its row.
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      firstActionRef.current?.focus();
      return;
    }
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    // Only when focus went down with the banner's buttons; never pull it off something else.
    if (trigger && document.activeElement === document.body) trigger.focus();
  }, [settingsOpen]);

  if (!asking && !settingsOpen) return null;

  // With nothing in force yet there is nothing to manage, so a reopen shows the first-run ask.
  const current = resolveConsent();
  const managing = settingsOpen && current !== 'unset';
  const kinds = [
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && 'analytics',
    (process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || process.env.NEXT_PUBLIC_META_PIXEL_ID) && 'advertising',
    'campaign attribution',
  ].filter(Boolean) as string[];
  const cookieKinds = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}` : kinds[0];

  const choose = (value: Consent) => {
    applyConsent(value);
    setAsking(false);
    closeSettings();
    // An injected pixel script cannot be unloaded, so a withdrawal only takes effect this
    // session through a reload. gtag honors it live; the ads pixels would keep running.
    if (current === 'granted' && value === 'denied') window.location.reload();
  };

  return (
    // A region, not a dialog: a dialog would also need a focus trap.
    <Box
      data-testid="cookie-consent-banner"
      role="region"
      aria-label="Cookie settings"
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
        {/* Focus lands where a stray Enter does least: Cancel when managing, Decline on the first-run ask. */}
        {managing && (
          <Button
            variant="plain"
            color="neutral"
            size="sm"
            onClick={closeSettings}
            ref={firstActionRef}
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
          ref={managing ? undefined : firstActionRef}
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
