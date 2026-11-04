import { api } from '@client/app/contexts/ApiContext';
import { Box, Button, LinearProgress, Typography } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

type Outcome = 'working' | 'failed';

/**
 * Where a custom connector's authorization server sends the user back. It forwards the one-time
 * parameters to the authenticated exchange API and then returns to Integrations. The provider's own
 * error text is never shown; the message is fixed.
 */
const McpOAuthCallbackPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [outcome, setOutcome] = useState<Outcome>('working');
  // The code is single use: a second run (StrictMode, a re-render) would only burn it.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const text = (key: string) => (typeof search[key] === 'string' ? (search[key] as string) : undefined);
    const code = text('code');
    const state = text('state');
    if (search.error || !code || !state) {
      setOutcome('failed');
      return;
    }
    api
      .post('/api/mcp-connections/oauth/callback', { code, state, iss: text('iss') })
      .then(() => navigate({ to: '/integrations', search: { tab: 'integrations' } }))
      .catch(() => setOutcome('failed'));
  }, [search, navigate]);

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
            onClick={() => navigate({ to: '/integrations', search: { tab: 'integrations' } })}
          >
            Back to Integrations
          </Button>
        </>
      )}
    </Box>
  );
};

export default McpOAuthCallbackPage;
