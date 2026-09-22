'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadMetaPixel } from '@client/app/utils/metaPixel';
import { loadRedditPixel } from '@client/app/utils/redditPixel';
import { readConsentRegion } from '@client/app/utils/consentRegion';

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

/**
 * Point the trackers at a consent state. Deliberately does not persist it: an
 * auto-allow is a fact about where the visitor is, not a choice they made, so
 * it is re-derived on every load the way the marketing site re-derives it. A
 * traveling visitor is then re-evaluated instead of being held to a decision
 * nobody took on their behalf.
 */
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
    const stored = getStoredConsent();
    if (stored !== null) {
      // Restore prior consent so GA4 respects it on every page load. An
      // explicit decision outranks the region either way - someone who
      // declined here is not re-granted by walking in from the marketing site.
      activateConsent(stored);
      return;
    }
    // No decision on file. Outside the opt-in region the marketing site grants
    // by default and shows nothing, so asking here would be this journey
    // asking halfway through for something it had already stopped asking.
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
