/**
 * /oauth/authorize
 *
 * B4M OAuth 2.0 Authorization endpoint (browser-facing).
 *
 * Flow:
 * 1. External product (VibesWire, VibesTrader...) redirects user here with PKCE params.
 * 2. If the user is already logged in -> generate auth code -> redirect back to the product.
 *    - First-party clients (and relying-party clients with a remembered consent) redirect
 *      silently. A relying-party client with no covering grant gets an Allow/Deny consent screen
 *      first; only Allow mints the code.
 * 3. If the user is NOT logged in -> send to /login with this URL as `redirectTo`.
 *    - Email/password login reads `redirectTo` from the URL and returns here.
 *    - Social/SSO login leaves the SPA, so MultiStepLogin appends `redirectTo`
 *      to the provider URL; it round-trips through the IdP state/RelayState
 *      param and the callback re-attaches it to /auth/success, which brings the
 *      user back here. (Without it the user lands on /new - the OAuth code is
 *      never issued - which only bites users without an existing B4M session.)
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { CircularProgress, Box, Typography, Button, List, ListItem } from '@mui/joy';

interface ConsentInfo {
  clientName: string;
  scopes: string[];
}

const OAuthAuthorizePage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const { accessToken, resetTokens } = useAccessToken();

  const [status, setStatus] = useState<'idle' | 'authorizing' | 'consent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [consentInfo, setConsentInfo] = useState<ConsentInfo | null>(null);
  const didRun = useRef(false);

  const {
    client_id,
    redirect_uri,
    response_type,
    scope = 'openid email profile',
    state,
    code_challenge,
    code_challenge_method,
    nonce,
    prompt,
  } = search;

  // Basic param validation
  // PKCE is optional - confidential clients (e.g. Cognito) use client_secret instead
  const paramsValid = client_id && redirect_uri && response_type === 'code';

  // Request an auth code. `consent` is true only after the user clicks Allow. A relying-party
  // client with no covering grant comes back with { consent_required } instead of a code.
  const requestCode = (consent?: boolean) => {
    setStatus('authorizing');
    fetch('/api/oauth/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge,
        code_challenge_method,
        nonce,
        prompt,
        ...(consent ? { consent: true } : {}),
      }),
    })
      .then(async r => {
        if (r.status === 401) {
          // Token expired - clear stale token so the re-render redirects to login
          resetTokens();
          return null;
        }
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error_description || body.error || `Authorization failed (${r.status})`);
        }
        return r.json();
      })
      .then(result => {
        if (!result) return; // Redirecting to login after token reset

        const { code, consent_required, client_name, scopes, error, error_description } = result;
        if (error) {
          setStatus('error');
          setErrorMsg(error_description || error);
          return;
        }
        if (consent_required) {
          setConsentInfo({ clientName: client_name || client_id!, scopes: scopes || [] });
          setStatus('consent');
          return;
        }

        const url = new URL(redirect_uri!);
        url.searchParams.set('code', code);
        if (state) url.searchParams.set('state', state);
        window.location.href = url.toString();
      })
      .catch(err => {
        setStatus('error');
        setErrorMsg(err.message);
      });
  };

  // OAuth 4.1.2.1: a denied consent returns the user to the client with error=access_denied.
  const denyConsent = () => {
    const url = new URL(redirect_uri!);
    url.searchParams.set('error', 'access_denied');
    if (state) url.searchParams.set('state', state);
    window.location.href = url.toString();
  };

  useEffect(() => {
    if (!paramsValid) return;

    if (!accessToken) {
      const currentUrl = window.location.pathname + window.location.search;
      navigate({ to: '/login', search: { redirectTo: currentUrl } });
      return;
    }

    if (status !== 'idle' || didRun.current) return;
    didRun.current = true;
    requestCode();
  }, [accessToken, status, paramsValid]);

  if (!paramsValid) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 2,
        }}
      >
        <Typography level="h4" color="danger">
          Invalid authorization request
        </Typography>
        <Typography level="body-sm" color="neutral">
          Missing required parameters: client_id, redirect_uri, response_type=code, code_challenge,
          code_challenge_method=S256
        </Typography>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 2,
        }}
      >
        <Typography level="h4" color="danger">
          Authorization failed
        </Typography>
        <Typography level="body-sm">{errorMsg}</Typography>
        <Button variant="outlined" onClick={() => window.history.back()}>
          Go back
        </Button>
      </Box>
    );
  }

  if (status === 'consent' && consentInfo) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 2,
          px: 2,
          textAlign: 'center',
        }}
      >
        <Typography level="h4">Authorize {consentInfo.clientName}</Typography>
        <Typography level="body-sm" color="neutral">
          {consentInfo.clientName} is requesting access to your Bike4Mind account:
        </Typography>
        <List sx={{ maxWidth: 360 }} data-testid="oauth-consent-scopes">
          {consentInfo.scopes.map(s => (
            <ListItem key={s}>{s}</ListItem>
          ))}
        </List>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="plain" color="neutral" data-testid="oauth-consent-deny-btn" onClick={denyConsent}>
            Deny
          </Button>
          <Button variant="solid" data-testid="oauth-consent-allow-btn" onClick={() => requestCode(true)}>
            Allow
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 2,
      }}
    >
      <CircularProgress size="lg" />
      <Typography level="body-sm" color="neutral">
        {status === 'authorizing' ? 'Authorizing...' : 'Signing you in...'}
      </Typography>
    </Box>
  );
};

export default OAuthAuthorizePage;
