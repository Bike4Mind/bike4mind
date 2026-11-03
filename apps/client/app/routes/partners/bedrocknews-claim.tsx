import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearch, Link } from '@tanstack/react-router';
import { Box, Button, CircularProgress, List, ListItem, Sheet, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useUserLogout } from '@client/app/hooks/data/user';
import useGetLogo from '@client/app/hooks/useGetLogo';

interface Rung {
  date: string;
  length: number;
  hard: boolean;
}

interface ClaimResult {
  total: number;
  balance: number | null;
  firstSolveCredits: number;
  capped: number;
}

type ClaimState =
  | { state: 'ready'; credits: number; rungs: Rung[]; account: string }
  | { state: 'done' | 'redeemed'; result: ClaimResult }
  | { state: 'verify-email' | 'expired' | 'not-found' | 'in-progress' | 'budget-spent' | 'unavailable' };

type View = { kind: 'loading' } | { kind: 'claim'; claim: ClaimState };

const ERROR_COPY: Record<string, string> = {
  expired: 'This claim link expired. Go back to Headword and press Claim again.',
  'not-found': 'This claim link isn\u2019t valid.',
  'in-progress': 'This claim is already being processed. Try again in a minute.',
  'budget-spent': 'Bike4Mind has paid out all of today\u2019s Headword credits. Yours are safe; try again later.',
  unavailable: 'Couldn\u2019t reach BedrockNews. Your credits are safe; try again.',
  'verify-email': 'Verify your email to claim credits.',
};

const PREVIEW_URL = '/api/partners/bedrocknews/claims/preview';
const REDEEM_URL = '/api/partners/bedrocknews/claims/redeem';

async function postClaim(url: string, ticket: string): Promise<ClaimState> {
  try {
    const { data } = await api.post<ClaimState>(url, { ticket });
    return data;
  } catch (error) {
    // The server answers a malformed ticket with 400 and the state in the body.
    const body = (error as { response?: { data?: ClaimState } })?.response?.data;
    return body && typeof body.state === 'string' ? body : { state: 'unavailable' };
  }
}

const rungLabel = ({ length, hard }: Rung) => `${length}-letter word${hard ? ' (hard)' : ''}`;

const BedrockNewsClaimPage = () => {
  const navigate = useNavigate();
  const { ticket } = useSearch({ strict: false }) as { ticket?: string };
  const { accessToken } = useAccessToken();
  const logoUrl = useGetLogo();
  const logout = useUserLogout();
  const appUrl = useGetSettingsValue('BedrockNewsAppUrl');

  const [view, setView] = useState<View>(
    ticket ? { kind: 'loading' } : { kind: 'claim', claim: { state: 'not-found' } }
  );
  const [confirming, setConfirming] = useState(false);
  const didPreview = useRef(false);

  useEffect(() => {
    if (!ticket) return;
    if (!accessToken) {
      navigate({ to: '/login', search: { redirectTo: window.location.pathname + window.location.search } });
      return;
    }
    if (didPreview.current) return;
    didPreview.current = true;
    postClaim(PREVIEW_URL, ticket).then(claim => setView({ kind: 'claim', claim }));
  }, [accessToken, ticket]);

  const confirm = async () => {
    if (!ticket || confirming) return;
    setConfirming(true);
    const claim = await postClaim(REDEEM_URL, ticket);
    setView({ kind: 'claim', claim });
    setConfirming(false);
  };

  // The logout teardown reads redirectTo from the current URL and sends the user to /login with it.
  const useAnotherAccount = () => {
    const back = encodeURIComponent(window.location.pathname + window.location.search);
    window.history.replaceState(null, '', `${window.location.pathname}?redirectTo=${back}`);
    logout.mutate();
  };

  const backHref =
    typeof appUrl === 'string' && appUrl
      ? `${appUrl.replace(/\/$/, '')}/games/headword${ticket ? `?claim=${encodeURIComponent(ticket)}` : ''}`
      : undefined;

  const shell = (children: ReactNode) => (
    <Box
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        px: 2,
        py: 4,
        backgroundColor: theme.palette.background.panel,
      })}
    >
      <Box component="img" src={logoUrl} alt="" sx={{ width: 56, height: 56, objectFit: 'contain', mb: 2 }} />
      <Sheet
        variant="outlined"
        data-testid="claim-card"
        sx={{
          width: '100%',
          maxWidth: 420,
          boxSizing: 'border-box',
          overflowWrap: 'anywhere',
          borderRadius: 'md',
          p: 3,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {children}
        {backHref && (
          <Typography level="body-sm">
            <a href={backHref} style={{ color: 'inherit', textDecoration: 'underline' }}>
              Back to Headword
            </a>
          </Typography>
        )}
      </Sheet>
    </Box>
  );

  if (view.kind === 'loading') {
    return (
      <Box
        data-testid="claim-loading"
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
          Checking your claim...
        </Typography>
      </Box>
    );
  }

  const { claim } = view;

  if (claim.state === 'ready') {
    return shell(
      <>
        <Box>
          <Typography level="h4" component="h1">
            Claim your Headword credits
          </Typography>
          <Typography level="title-md" sx={{ mt: 1 }}>
            {claim.credits} credits from BedrockNews Headword
          </Typography>
          <Typography level="body-sm" textColor="text.primary" sx={{ mt: 0.5 }}>
            to {claim.account}
          </Typography>
        </Box>
        <List sx={{ '--ListItem-paddingX': '0px' }}>
          {claim.rungs.map(rung => (
            <ListItem key={`${rung.date}-${rung.length}`} data-testid="claim-rung">
              <Typography level="body-sm" textColor="text.primary">
                {rung.date} · {rungLabel(rung)}
              </Typography>
            </ListItem>
          ))}
        </List>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1 }}>
          <Button variant="plain" color="neutral" disabled={confirming || logout.isPending} onClick={useAnotherAccount}>
            Use another account
          </Button>
          <Button
            data-testid="claim-confirm-btn"
            loading={confirming}
            disabled={confirming}
            onClick={confirm}
            loadingIndicator={<CircularProgress size="sm" />}
          >
            Add {claim.credits} credits
          </Button>
        </Box>
      </>
    );
  }

  if (claim.state === 'done' || claim.state === 'redeemed') {
    const { total, balance, firstSolveCredits, capped } = claim.result;
    return shell(
      <>
        {total > 0 && (
          <Typography level="h4" component="h1">
            {total} credits added
          </Typography>
        )}
        {total === 0 && capped <= 0 && (
          <Typography level="h4" component="h1">
            These credits were already claimed
          </Typography>
        )}
        {total > 0 && balance != null && <Typography level="body-md">Balance {balance}</Typography>}
        {total > 0 && firstSolveCredits > 0 && (
          <Typography level="body-md">+{firstSolveCredits} first-solve bonus</Typography>
        )}
        {capped > 0 && (
          <Typography level="body-md">
            Bike4Mind&rsquo;s daily limit is reached for that day, so those credits can&rsquo;t be paid.
          </Typography>
        )}
      </>
    );
  }

  return shell(
    <>
      <Typography
        level="body-md"
        textColor="text.primary"
        color={claim.state === 'verify-email' ? undefined : 'danger'}
      >
        {ERROR_COPY[claim.state] ?? ERROR_COPY.unavailable}
      </Typography>
      {claim.state === 'verify-email' && (
        <Typography level="body-sm">
          <Link to="/new" data-testid="claim-verify-link" style={{ color: 'inherit', textDecoration: 'underline' }}>
            Verify your email
          </Link>
        </Typography>
      )}
    </>
  );
};

export default BedrockNewsClaimPage;
