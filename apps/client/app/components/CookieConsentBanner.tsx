'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadMetaPixel } from '@client/app/utils/metaPixel';
import { loadRedditPixel } from '@client/app/utils/redditPixel';
import { readConsentRegion, readSharedConsent } from '@client/app/utils/consentRegion';

const CONSENT_KEY = 'cookie_consent';

declare function gtag(...args: unknown[]): void;

function getStoredConsent(): 'granted' | 'denied' | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw === 'granted' || raw === 'denied' ? raw : null;
  } catch {
    return null;
  }
}

/** Point the trackers at a consent state. Deliberately does not persist it, so an
 * auto-allow is re-derived each load rather than freezing the answer for someone
 * who travels. */
function activateConsent(value: 'granted' | 'denied') {
  if (typeof gtag !== 'undefined') {
    gtag('consent', 'update', { analytics_storage: value });
  }
  // The ads pixels have no consent-mode equivalent: granted == load the scripts
  // (until then they only queue in memory), denied == they never load. Each
  // no-ops when its own pixel id is unconfigured.
  if (value === 'granted') {
    loadRedditPixel();
    loadMetaPixel();
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
    // Precedence: this origin's decision, then one made on the marketing site, then
    // the region. Only the first two are decisions; the region is a default for a
    // visitor who has made none, so it must never override someone who declined on
    // the other host - they cannot come back and decline again here (#3184).
    const decision = getStoredConsent() ?? readSharedConsent();
    if (decision !== null) {
      activateConsent(decision);
      return;
    }
    // Outside the opt-in region the marketing site grants by default and shows
    // nothing, so asking here would be one journey asking halfway through.
    if (readConsentRegion() === 'row') {
      activateConsent('granted');
      return;
    }
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
