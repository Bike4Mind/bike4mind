'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { APP_NAME } from '@client/config/general';
import { loadRedditPixel } from '@client/app/utils/redditPixel';

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

function applyConsent(value: 'granted' | 'denied') {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // ignore storage errors
  }
  if (typeof gtag !== 'undefined') {
    gtag('consent', 'update', { analytics_storage: value });
  }
  // The ads pixel has no consent-mode equivalent: granted == load the script
  // (until then it only queues in memory), denied == it never loads.
  if (value === 'granted') {
    loadRedditPixel();
  }
}

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = getStoredConsent();
    if (stored === null) {
      setVisible(true);
    } else {
      // Restore prior consent so GA4 respects it on every page load
      applyConsent(stored);
    }
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
        {process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ? ' and advertising' : ''} cookies.
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
