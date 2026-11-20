/**
 * /oauth/logout
 *
 * OIDC RP-Initiated Logout (discovery's end_session_endpoint). A relying party sends the browser
 * here with client_id, post_logout_redirect_uri, state and id_token_hint. All validation and the
 * sign-out happen in POST /api/oauth/end-session; this page only renders its answer and follows
 * the redirect target it returns, never one read from the URL.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Button, CircularProgress, Sheet, Typography } from '@mui/joy';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useUser } from '@client/app/contexts/UserContext';
import { clearClientSession } from '@client/app/hooks/data/user';
import { resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';
import useGetLogo from '@client/app/hooks/useGetLogo';

type EndSessionResponse =
  | { status: 'confirmation_required'; client_name: string; redirect_to: string | null }
  | { status: 'signed_out'; redirect_to: string | null };

type PageState =
  | { kind: 'working' }
  | { kind: 'confirm'; clientName: string; redirectTo: string | null }
  | { kind: 'signed_out' }
  | { kind: 'error'; message: string };

const OAuthLogoutPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const { accessToken, resetTokens } = useAccessToken();
  const { setCurrentUser } = useUser();
  const queryClient = useQueryClient();
  const logoUrl = useGetLogo();
  const [page, setPage] = useState<PageState>({ kind: 'working' });
  const didRun = useRef(false);

  const { client_id, post_logout_redirect_uri, state, id_token_hint } = search;

  const endSession = async (confirm: boolean) => {
    setPage({ kind: 'working' });
    try {
      const r = await fetch('/api/oauth/end-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          client_id,
          post_logout_redirect_uri,
          state,
          id_token_hint,
          ...(confirm ? { confirm } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPage({ kind: 'error', message: body.error_description || body.error || `Sign-out failed (${r.status})` });
        return;
      }
      const result = body as EndSessionResponse;
      if (result.status === 'confirmation_required') {
        setPage({ kind: 'confirm', clientName: result.client_name, redirectTo: result.redirect_to });
        return;
      }
      await clearClientSession({ setCurrentUser, resetTokens, queryClient });
      resetSessionBootstrap();
      if (result.redirect_to) {
        window.location.replace(result.redirect_to);
        return;
      }
      setPage({ kind: 'signed_out' });
    } catch (err) {
      setPage({ kind: 'error', message: err instanceof Error ? err.message : 'Sign-out failed' });
    }
  };

  // Back to the RP only through a target the server validated; otherwise stay in the app.
  const staySignedIn = (redirectTo: string | null) => {
    if (redirectTo) window.location.replace(redirectTo);
    else navigate({ to: '/' });
  };

  // Either one names the client (OIDC RP-Initiated Logout 1.0, section 2).
  const hasClient = Boolean(client_id || id_token_hint);

  useEffect(() => {
    if (!hasClient || didRun.current) return;
    didRun.current = true;
    void endSession(false);
  }, [hasClient]);

  const centered = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    px: 2,
    gap: 2,
  } as const;

  if (!hasClient || page.kind === 'error') {
    return (
      <Box sx={centered} data-testid="oauth-logout-error">
        <Typography level="h4" component="h1" color="danger">
          Sign-out request failed
        </Typography>
        <Typography level="body-sm" textColor="text.primary" data-testid="oauth-logout-error-message">
          {page.kind === 'error' ? page.message : 'Missing required parameter: client_id or id_token_hint'}
        </Typography>
      </Box>
    );
  }

  if (page.kind === 'confirm') {
    return (
      <Box sx={centered}>
        <Box component="img" src={logoUrl} alt="" sx={{ width: 56, height: 56, objectFit: 'contain' }} />
        <Sheet
          variant="outlined"
          sx={{
            width: '100%',
            maxWidth: 420,
            borderRadius: 'md',
            p: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
          data-testid="oauth-logout-confirm"
        >
          <Box>
            <Typography level="h4" component="h1">
              Sign out of Bike4Mind?
            </Typography>
            <Typography level="body-sm" textColor="text.primary" sx={{ mt: 0.5 }}>
              {page.clientName} asked to also end your Bike4Mind session in this browser.
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button
              variant="plain"
              color="neutral"
              data-testid="oauth-logout-stay-btn"
              onClick={() => staySignedIn(page.redirectTo)}
            >
              Stay signed in
            </Button>
            <Button variant="solid" data-testid="oauth-logout-confirm-btn" onClick={() => void endSession(true)}>
              Sign out
            </Button>
          </Box>
        </Sheet>
      </Box>
    );
  }

  if (page.kind === 'signed_out') {
    return (
      <Box sx={centered} data-testid="oauth-logout-signed-out">
        <Typography level="h4" component="h1">
          You&apos;re signed out of Bike4Mind
        </Typography>
        <Button variant="outlined" data-testid="oauth-logout-sign-in-btn" onClick={() => navigate({ to: '/login' })}>
          Sign in again
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={centered}>
      <CircularProgress size="lg" />
      <Typography level="body-sm" color="neutral">
        Signing you out...
      </Typography>
    </Box>
  );
};

export default OAuthLogoutPage;
