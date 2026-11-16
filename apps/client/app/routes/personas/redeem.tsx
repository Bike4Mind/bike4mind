import { useEffect, useRef, useState } from 'react';
import { Box, Card, CircularProgress, Typography } from '@mui/joy';
import { getCapturedCode, redeemPersonaCode } from './personaRedeemCode';

type PageState = { status: 'redeeming' } | { status: 'failed'; message: string };

const MISSING_CODE = 'This login link has no code. Open the full login_path from the persona mint response.';

/** Signs the browser in as a test persona from the code its login_path carried in the fragment. */
export default function PersonaRedeemPage() {
  const [state, setState] = useState<PageState>(() =>
    getCapturedCode() ? { status: 'redeeming' } : { status: 'failed', message: MISSING_CODE }
  );
  // The code is single-use: a second POST (StrictMode re-running the effect) would only fail.
  const started = useRef(false);

  useEffect(() => {
    const code = getCapturedCode();
    if (!code || started.current) return;
    started.current = true;
    void redeemPersonaCode(code).then(result => {
      // A full load, so the app boots from the session cookie the redeem call just set.
      if (result.ok) window.location.replace('/');
      else setState({ status: 'failed', message: result.message });
    });
  }, []);

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Card sx={{ maxWidth: 480, width: '100%', textAlign: 'center', p: 4 }}>
        {state.status === 'redeeming' ? (
          <>
            <CircularProgress sx={{ mx: 'auto' }} />
            <Typography level="body-md" data-testid="persona-redeem-progress">
              Signing in...
            </Typography>
          </>
        ) : (
          <>
            <Typography level="h4">Could not sign in</Typography>
            <Typography level="body-md" data-testid="persona-redeem-error">
              {state.message}
            </Typography>
          </>
        )}
      </Card>
    </Box>
  );
}
