'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadMetaPixel } from '@client/app/utils/metaPixel';
import { loadRedditPixel } from '@client/app/utils/redditPixel';
import { CONSENT_KEY, publishResolvedConsent, resolveConsent } from '@client/app/utils/consentRegion';
import { clearAttributionCookies, flushUtmCapture } from '@client/app/utils/utmCapture';

declare function gtag(...args: unknown[]): void;

/** Point the trackers at a consent state. Deliberately does not persist it as a DECISION, so
 * an auto-allow is re-derived each load rather than freezing the answer for someone who
 * travels. The cookie published below is not that: it caches the resolution this load reached
 * so the server can read it, is rewritten every load, and is cleared when the resolution goes
 * back to 'unset' - see publishResolvedConsent. */
function activateConsent(value: 'granted' | 'denied') {
  // Before the trackers, so a handler that beats them still sees the right answer. The server
  // cannot read localStorage, and an OAuth signup is credited by a request, not by this page.
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
function applyConsent(value: 'granted' | 'denied') {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // ignore storage errors
  }
  activateConsent(value);
}

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Precedence lives in resolveConsent, shared with every other non-essential feature
    // that has to gate on the same answer (utmCapture's attribution cookies): this
    // origin's decision, then one made on the marketing site, then the region. The region
    // is only a default for a visitor who has made no decision anywhere, so it never
    // overrides someone who declined on the other host - they cannot come back and
    // decline again here (#3184). Outside the opt-in region the marketing site grants by
    // default and shows nothing, so asking here would be one journey asking halfway through.
    const state = resolveConsent();
    if (state !== 'unset') {
      activateConsent(state);
      return;
    }
    // No decision anywhere: withdraw any cookie a previous load published, so a visitor who
    // carried an auto-allow into the opt-in region is suppressed server-side while they are
    // being asked here, rather than attributed off a resolution that no longer holds.
    publishResolvedConsent('unset');
    setVisible(true);
  }, []);

  if (!visible) return null;

  const handleAccept = () => {
    applyConsent('granted');
    setVisible(false);
  };

  const handleDecline = () => {
    applyConsent('denied');
    setVisible(false);
  };

  return (
    <Box
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
      {/* brand externalized */}
      <Typography level="body-sm" sx={{ flex: 1, minWidth: 200 }}>
        We use cookies to understand how you use {APP_NAME || 'this app'} and to improve your experience. By clicking
        &ldquo;Accept&rdquo;, you consent to our use of analytics
        {process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || process.env.NEXT_PUBLIC_META_PIXEL_ID
          ? ' and advertising'
          : ''}{' '}
        cookies.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          onClick={handleDecline}
          data-testid="cookie-consent-decline-btn"
        >
          Decline
        </Button>
        <Button
          variant="solid"
          color="primary"
          size="sm"
          onClick={handleAccept}
          data-testid="cookie-consent-accept-btn"
        >
          Accept
        </Button>
      </Box>
    </Box>
  );
}
