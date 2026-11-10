import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { premiumNavItems } from '@client/app/premium-generated/premiumNavItems.generated';
import { premiumNavItemForRedirect } from '@client/app/utils/premiumNav';

/**
 * "Sign in to continue to <product>" (or the sign-up wording) when the page's `?redirectTo=` leads into a
 * premium product's nav path; nothing otherwise. Shared by MultiStepLogin and Register, which both carry
 * `redirectTo` through to the post-login redirect.
 */
export default function RedirectProductHint({ mode }: { mode: 'signIn' | 'signUp' }) {
  const { t } = useTranslation();
  // Read once: the query only changes by navigating away from the page.
  const [item] = useState(() =>
    typeof window === 'undefined'
      ? undefined
      : premiumNavItemForRedirect(premiumNavItems, new URLSearchParams(window.location.search).get('redirectTo'))
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
      }}
    >
      {t(mode === 'signIn' ? 'auth.signInToContinueTo' : 'auth.signUpToContinueTo', { product: item.label })}
    </Typography>
  );
}
