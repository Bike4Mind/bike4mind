import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/joy/Box';
import type { PremiumNavDescriptor } from '@client/app/premiumContract';
import Typography from '@mui/joy/Typography';
import { premiumNavItems } from '@client/app/premium-generated/premiumNavItems.generated';
import { premiumNavItemForRedirect } from '@client/app/utils/premiumNav';
import { sanitizeRedirectTo } from '@client/app/utils/authRedirect';

// The item's own name for what the redirect carries, read from the sanitized redirect's query. Never throws:
// the callback is the product's and the input is a signed-out visitor's.
function targetNameOf(item: PremiumNavDescriptor, redirectTo: string | null): string | null {
  if (!item.redirectTargetName) return null;
  try {
    const safe = sanitizeRedirectTo(redirectTo);
    if (!safe) return null;
    return item.redirectTargetName(new URL(safe, 'http://localhost').searchParams) || null;
  } catch {
    return null;
  }
}

/**
 * "Sign in to continue to <product>" (or the sign-up wording) when the page's `?redirectTo=` leads into a
 * premium product's nav path; nothing otherwise. When the item names a target from the redirect's query
 * (`redirectTargetName`, e.g. the site a landing carried through), the line says "Sign in and <product> reads
 * <site>" instead. Shared by MultiStepLogin and Register, which both carry
 * `redirectTo` through to the post-login redirect.
 */
export default function RedirectProductHint({ mode }: { mode: 'signIn' | 'signUp' }) {
  const { t } = useTranslation();
  // Read once: the query only changes by navigating away from the page.
  const [{ item, site }] = useState(() => {
    if (typeof window === 'undefined') return {};
    const redirectTo = new URLSearchParams(window.location.search).get('redirectTo');
    const found = premiumNavItemForRedirect(premiumNavItems, redirectTo);
    return { item: found, site: found ? targetNameOf(found, redirectTo) : null };
  });
  if (!item) return null;
  const Icon = item.icon;
  return (
    <Typography
      data-testid="auth-redirect-product-hint"
      startDecorator={
        Icon ? (
          <Box component="span" aria-hidden sx={{ display: 'inline-flex' }}>
            <Icon />
          </Box>
        ) : undefined
      }
      sx={{
        color: 'text.secondary',
        fontSize: '14px',
        fontWeight: 500,
        mt: '8px',
        justifyContent: 'center',
        textAlign: 'center',
      }}
    >
      {/* React escapes the text node, so i18next must not HTML-escape the label as well. */}
      {t(
        site
          ? mode === 'signIn'
            ? 'auth.signInProductReads'
            : 'auth.signUpProductReads'
          : mode === 'signIn'
            ? 'auth.signInToContinueTo'
            : 'auth.signUpToContinueTo',
        {
          product: item.label,
          site,
          interpolation: { escapeValue: false },
        }
      )}
    </Typography>
  );
}
