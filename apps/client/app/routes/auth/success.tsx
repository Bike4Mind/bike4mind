import { useEffect, useRef } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { CircularProgress, Container, Typography, Box } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { resetRefreshPromise } from '@client/app/contexts/ApiContext';
import { parseAuthParams } from '@client/app/utils/authParams';
import { applyRedirect } from '@client/app/utils/authRedirect';
import { trackSignupConversion } from '@client/app/utils/signupConversion';

const AuthSuccessPage = () => {
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ strict: false });
  const { setCurrentUser } = useUser();
  const { setAccessToken, setRefreshToken } = useAccessToken();
  const hasProcessed = useRef(false);

  useEffect(() => {
    // Guard against Strict Mode double-invoke and React 18 Concurrent Mode
    // re-renders: hasProcessed ensures auth setup fires exactly once per mount.
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const handleAuthSuccess = async () => {
      const { token, refreshToken, error, userId, isNewUser, signupMethod } = parseAuthParams(
        search as Record<string, unknown>
      );

      if (error) {
        console.error('Authentication error:', error);
        navigate({ to: '/login', search: { error: error as string } });
        return;
      }

      if (token && refreshToken && userId) {
        try {
          // Set the tokens - reset any stale refresh promise first
          resetRefreshPromise();
          setAccessToken(token as string);
          setRefreshToken(refreshToken as string);

          const response = await fetch(`/api/users/${userId}`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          if (response.ok) {
            const userData = await response.json();
            setCurrentUser(userData);

            // Fire the signup ad conversion for brand-new OAuth accounts.
            // Exactly once: the hash carrying isNewUser was cleared by
            // parseAuthParams, and hasProcessed guards this effect - a reload
            // or re-render can't re-fire it.
            if (isNewUser) {
              trackSignupConversion(signupMethod || 'oauth');
            }

            // Redirect to the originally requested page or dashboard. The
            // social/SSO callback round-trips `redirectTo` through the IdP
            // state/RelayState param and re-attaches it to this route's query
            // (validated here by applyRedirect -> sanitizeRedirectTo, the same
            // chokepoint the email flow uses).
            //
            // Go through router history (not navigate({ to })) so an embedded
            // query string survives - e.g. the OAuth authorize URL
            // `/oauth/authorize?client_id=...&redirect_uri=...`, which navigate({ to })
            // would URL-encode into the path and break.
            applyRedirect(router.history, (search as { redirectTo?: string }).redirectTo);
          } else {
            throw new Error(`Failed to fetch user data: ${response.statusText}`);
          }
        } catch (error) {
          console.error('Error setting up authentication:', error);
          navigate({ to: '/login', search: { error: 'auth_setup_failed' } });
        }
      } else {
        // No tokens in the URL. React 18 Concurrent Mode briefly re-renders the
        // outgoing route component during a navigation transition, creating a fresh
        // component instance after the hash has already been cleared by the first
        // mount. If the access token is already in the store, auth completed
        // successfully - redirect to the destination instead of showing an error.
        // A user with a persisted (localStorage) token who reaches this page
        // with no hash/error is also redirected rather than shown missing_tokens:
        // they hold a valid session, so forwarding them is the correct outcome.
        const { accessToken } = useAccessToken.getState();
        if (accessToken) {
          applyRedirect(router.history, (search as { redirectTo?: string }).redirectTo);
        } else {
          navigate({ to: '/login', search: { error: 'missing_tokens' } });
        }
      }
    };

    handleAuthSuccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, setCurrentUser, setAccessToken, setRefreshToken]);

  return (
    <Container
      maxWidth="sm"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Box sx={{ textAlign: 'center' }}>
        <CircularProgress size="lg" sx={{ mb: 2 }} />
        <Typography level="h4" sx={{ mb: 1 }}>
          Completing sign in...
        </Typography>
        <Typography level="body-sm" color="neutral">
          Please wait while we set up your session.
        </Typography>
      </Box>
    </Container>
  );
};

export default AuthSuccessPage;
