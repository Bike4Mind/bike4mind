import { api } from '@client/app/contexts/ApiContext';
import { Box, Button, LinearProgress, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { clearMcpOAuthCallbackBootSearch, getMcpOAuthCallbackBootSearch } from '@client/app/utils/mcpOAuthCallback';

type Outcome = 'working' | 'failed';

// States whose code was already spent. Back can remount the page at the callback URL (through /login or
// /auth/success), where the address bar still holds the spent code; every hop is in one document.
const spentStates = new Set<string>();

/**
 * Where a custom connector's authorization server sends the user back. It forwards the one-time
 * parameters to the authenticated exchange API and then returns to Integrations. The provider's own
 * error text is never shown; the message is fixed.
 */
const McpOAuthCallbackPage = () => {
  const navigate = useNavigate();
  // The query as the server sent it: the router's parsed copy turns an all-digit `code` into a number. The
  // snapshot is null after an SSO login (a fresh page load), where the address bar still holds the raw query.
  const [params] = useState(() => new URLSearchParams(getMcpOAuthCallbackBootSearch() ?? window.location.search));
  const code = params.get('code') ?? undefined;
  const state = params.get('state') ?? undefined;
  const iss = params.get('iss') ?? undefined;
  const providerError = params.get('error');
  const unusable = Boolean(providerError) || !code || !state;
  const [exchangeFailed, setExchangeFailed] = useState(false);
  const outcome: Outcome = unusable || exchangeFailed ? 'failed' : 'working';
  // The code is single use: a second run (StrictMode, a re-render) would only burn it.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || unusable || !state) return;
    started.current = true;
    const toIntegrations = () =>
      // A navigation failure is not an exchange failure.
      Promise.resolve(navigate({ to: '/integrations', search: { tab: 'integrations' }, replace: true })).catch(
        () => undefined
      );
    if (spentStates.has(state)) {
      void toIntegrations();
      return;
    }
    api.post('/api/mcp-connections/oauth/callback', { code, state, iss }).then(
      () => {
        spentStates.add(state);
        clearMcpOAuthCallbackBootSearch();
        void toIntegrations();
      },
      () => setExchangeFailed(true)
    );
  }, [unusable, code, state, iss, navigate]);

  return (
    <Box sx={{ maxWidth: 480, mx: 'auto', mt: 12, px: 2 }} data-testid="mcp-oauth-callback-page">
      {outcome === 'working' ? (
        <>
          <Typography level="title-md" sx={{ mb: 2 }}>
            Finishing sign-in
          </Typography>
          <LinearProgress data-testid="mcp-oauth-callback-progress" />
        </>
      ) : (
        <>
          <Typography level="title-md" color="danger" data-testid="mcp-oauth-callback-error">
            Sign-in could not be completed. Please try connecting again.
          </Typography>
          <Button
            sx={{ mt: 2 }}
            data-testid="mcp-oauth-callback-back-btn"
            onClick={() => navigate({ to: '/integrations', search: { tab: 'integrations' }, replace: true })}
          >
            Back to Integrations
          </Button>
        </>
      )}
    </Box>
  );
};

export default McpOAuthCallbackPage;
