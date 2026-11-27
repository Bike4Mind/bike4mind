import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import type { PremiumNavDescriptor } from '@client/app/premiumContract';
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
 * The premium product the page's `?redirectTo=` leads into, or undefined. MultiStepLogin and Register
 * read it once to show RedirectProductHint and to drop copy that would compete with the hint.
 */
export function useRedirectProduct(): PremiumNavDescriptor | undefined {
  // Read once: the query only changes by navigating away from the page.
  const [item] = useState(() =>
    typeof window === 'undefined'
      ? undefined
      : premiumNavItemForRedirect(premiumNavItems, new URLSearchParams(window.location.search).get('redirectTo'))
  );
  return item;
}

/**
 * "Sign in to continue to <product>" (or the sign-up wording) for the product useRedirectProduct found;
 * nothing when there is none. When the item names a target from the redirect's query
 * (`redirectTargetName`, e.g. the site a landing carried through), the line says "Sign in and <product> reads
 * <site>" instead. Shared by MultiStepLogin and Register, which both carry
 * `redirectTo` through to the post-login redirect.
 */
export default function RedirectProductHint({
  mode,
  item,
}: {
  mode: 'signIn' | 'signUp';
  item: PremiumNavDescriptor | undefined;
}) {
  const { t } = useTranslation();
  const [site] = useState(() =>
    item && typeof window !== 'undefined'
      ? targetNameOf(item, new URLSearchParams(window.location.search).get('redirectTo'))
      : null
  );
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
        // A long site name has no spaces to wrap at.
        overflowWrap: 'anywhere',
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
