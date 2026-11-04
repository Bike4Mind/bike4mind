import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearch, Link } from '@tanstack/react-router';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link as JoyLink,
  List,
  ListItem,
  Sheet,
  Typography,
} from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy';
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import HighlightOffRounded from '@mui/icons-material/HighlightOffRounded';
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useUserLogout } from '@client/app/hooks/data/user';
import useGetLogo from '@client/app/hooks/useGetLogo';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { takeTicket } from './bedrocknewsClaimTicket';

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
  | { state: 'ready'; credits: number; payable?: number; rungs: Rung[]; account: string }
  | { state: 'done' | 'redeemed'; result: ClaimResult }
  | {
      state:
        'verify-email' | 'expired' | 'not-found' | 'in-progress' | 'claimed-elsewhere' | 'budget-spent' | 'unavailable';
    };

type MessageState = Exclude<ClaimState['state'], 'ready' | 'done' | 'redeemed'> | 'already' | 'capped';

type View = { kind: 'loading' } | { kind: 'claim'; claim: ClaimState };

const PREVIEW_URL = '/api/partners/bedrocknews/claims/preview';
const REDEEM_URL = '/api/partners/bedrocknews/claims/redeem';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function toClaimState(body: unknown): ClaimState {
  if (!isRecord(body) || typeof body.state !== 'string') return { state: 'unavailable' };
  if ((body.state === 'done' || body.state === 'redeemed') && !isRecord(body.result)) return { state: 'unavailable' };
  if (body.state === 'ready' && !Array.isArray(body.rungs)) return { state: 'unavailable' };
  return body as ClaimState;
}

async function postClaim(url: string, ticket: string): Promise<ClaimState> {
  try {
    const { data } = await api.post<unknown>(url, { ticket });
    return toClaimState(data);
  } catch (error) {
    // The server answers a malformed ticket with 400 and the state in the body.
    return toClaimState((error as { response?: { data?: unknown } })?.response?.data);
  }
}

const headwordUrl = (appUrl: unknown, ticket: string | undefined) => {
  if (typeof appUrl !== 'string' || !/^https?:\/\//.test(appUrl)) return undefined;
  return `${appUrl.replace(/\/$/, '')}/games/headword${ticket ? `#claim=${encodeURIComponent(ticket)}` : ''}`;
};

const CAPPED_NOTE =
  'Bike4Mind\u2019s daily limit is reached for that day, so those credits can\u2019t be paid. They stay waiting in Headword.';

const MESSAGES: Record<
  MessageState,
  { tone: ColorPaletteProp; icon: ReactNode; title: string; body: string; action?: 'retry' | 'verify' }
> = {
  'verify-email': {
    tone: 'primary',
    icon: <MailOutlineRounded />,
    title: 'Verify your email',
    body: 'Verify your email to claim credits.',
    action: 'verify',
  },
  expired: {
    tone: 'warning',
    icon: <AccessTimeRounded />,
    title: 'This link expired',
    body: 'This claim link expired. Go back to Headword and press Claim again.',
  },
  'not-found': {
    tone: 'danger',
    icon: <HighlightOffRounded />,
    title: 'This link isn\u2019t valid',
    body: 'This claim link isn\u2019t valid. Go back to Headword and press Claim again.',
  },
  'in-progress': {
    tone: 'neutral',
    icon: <AccessTimeRounded />,
    title: 'Already in progress',
    body: 'This claim is already being processed. Try again in a minute.',
    action: 'retry',
  },
  'claimed-elsewhere': {
    tone: 'warning',
    icon: <HighlightOffRounded />,
    title: 'Claimed by another account',
    body: 'These credits were already added to a different Bike4Mind account.',
  },
  'budget-spent': {
    tone: 'warning',
    icon: <WarningAmberRounded />,
    title: 'Today\u2019s credits are paid out',
    body: 'Bike4Mind has paid out all of today\u2019s Headword credits. Yours are safe; try again later.',
    action: 'retry',
  },
  unavailable: {
    tone: 'neutral',
    icon: <WarningAmberRounded />,
    title: 'We couldn\u2019t finish this',
    body: 'Something went wrong on our side. Your credits are safe; try again.',
    action: 'retry',
  },
  already: {
    tone: 'neutral',
    icon: <CheckRounded />,
    title: 'Already claimed',
    body: 'These credits were already claimed.',
  },
  capped: { tone: 'warning', icon: <WarningAmberRounded />, title: 'Daily limit reached', body: CAPPED_NOTE },
};

const STATUS_MESSAGES = new Set<MessageState>(['already', 'capped']);

const ACTION_SX = { minHeight: 44, fontSize: '15px' } as const;
const LABEL_SX = { fontSize: '13px', fontWeight: 600 } as const;
const TILE_SX = { display: 'flex', flexDirection: 'column-reverse', p: '12px 14px', borderRadius: 'md' } as const;

const ClaimShell = ({ logoUrl, busy, children }: { logoUrl: string; busy?: boolean; children: ReactNode }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 3,
      minHeight: '100vh',
      boxSizing: 'border-box',
      p: { xs: '28px 12px', sm: '48px 16px' },
      bgcolor: 'background.body',
    }}
  >
    <Box component="img" src={logoUrl} alt="Bike4Mind" sx={{ height: 60, width: 'auto', objectFit: 'contain' }} />
    <Sheet
      component="main"
      variant="outlined"
      data-testid="claim-card"
      aria-busy={busy || undefined}
      sx={{
        width: '100%',
        maxWidth: 440,
        boxSizing: 'border-box',
        overflowWrap: 'anywhere',
        borderRadius: 'lg',
        p: { xs: '20px', sm: '28px' },
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
      }}
    >
      {children}
    </Sheet>
    <Typography textColor="text.tertiary" sx={{ maxWidth: 440, textAlign: 'center', fontSize: '12px' }}>
      Credits are paid only after you confirm. This link works for 30 minutes.
    </Typography>
  </Box>
);

const BackLink = ({ href }: { href?: string }) =>
  href ? (
    <JoyLink
      href={href}
      startDecorator={<ArrowBackRounded />}
      sx={{ alignSelf: 'center', minHeight: 44, fontSize: '14px', fontWeight: 600 }}
    >
      Back to Headword
    </JoyLink>
  ) : null;

const BackButton = ({ href }: { href?: string }) => (
  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
    {href && (
      <Button component="a" href={href} startDecorator={<ArrowBackRounded />} sx={{ ...ACTION_SX, flex: '1 1 180px' }}>
        Back to Headword
      </Button>
    )}
    <Button component={Link} to="/" variant="outlined" color="neutral" sx={{ ...ACTION_SX, flex: '1 1 180px' }}>
      Open Bike4Mind
    </Button>
  </Box>
);

const ToneCircle = ({ tone, children }: { tone: ColorPaletteProp; children: ReactNode }) => (
  <Sheet
    variant="soft"
    color={tone}
    aria-hidden
    sx={{
      width: 52,
      height: 52,
      flex: 'none',
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      '& svg': { fontSize: 24 },
    }}
  >
    {children}
  </Sheet>
);

const LimitNote = ({ children }: { children: ReactNode }) => (
  <Alert role="note" variant="soft" color="warning" startDecorator={<WarningAmberRounded />} sx={{ fontSize: '14px' }}>
    <span>{children}</span>
  </Alert>
);

const MessageView = ({ state, action, backHref }: { state: MessageState; action?: ReactNode; backHref?: string }) => {
  const { tone, icon, title, body } = MESSAGES[state];
  return (
    <>
      <Box
        role={STATUS_MESSAGES.has(state) ? 'status' : 'alert'}
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, textAlign: 'center', pt: 1.5 }}
      >
        <ToneCircle tone={tone}>{icon}</ToneCircle>
        <Typography component="h1" sx={{ mt: 0.5, fontSize: '20px', fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography textColor="text.secondary" sx={{ fontSize: '15px', maxWidth: 340 }}>
          {body}
        </Typography>
      </Box>
      {action ?? <BackButton href={backHref} />}
      {action && <BackLink href={backHref} />}
    </>
  );
};

const DoneView = ({ result, account, backHref }: { result: ClaimResult; account?: string; backHref?: string }) => {
  const { total, balance, firstSolveCredits, capped } = result;
  if (total <= 0) return <MessageView state={capped > 0 ? 'capped' : 'already'} backHref={backHref} />;
  return (
    <>
      <Box
        role="status"
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, textAlign: 'center', pt: 1 }}
      >
        <ToneCircle tone="success">
          <CheckRounded />
        </ToneCircle>
        <Typography component="h1" sx={{ mt: 0.5, fontSize: '22px', fontWeight: 700 }}>
          {total} credits added
        </Typography>
        {account && (
          <Typography textColor="text.secondary" sx={{ fontSize: '14px' }}>
            to {account}
          </Typography>
        )}
      </Box>
      {(balance != null || firstSolveCredits > 0) && (
        <Box
          component="dl"
          sx={{ m: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))', gap: 1 }}
        >
          {balance != null && (
            <Sheet variant="outlined" sx={TILE_SX}>
              <Typography component="dt" textColor="text.tertiary" sx={{ fontSize: '13px' }}>
                New balance
              </Typography>
              <Typography component="dd" sx={{ m: 0, fontSize: '22px', fontWeight: 700 }}>
                {balance}
              </Typography>
            </Sheet>
          )}
          {firstSolveCredits > 0 && (
            <Sheet variant="soft" color="success" sx={TILE_SX}>
              <Typography component="dt" textColor="inherit" sx={{ fontSize: '13px' }}>
                First-solve bonus
              </Typography>
              <Typography component="dd" textColor="inherit" sx={{ m: 0, fontSize: '22px', fontWeight: 700 }}>
                +{firstSolveCredits}
              </Typography>
            </Sheet>
          )}
        </Box>
      )}
      {capped > 0 && <LimitNote>{CAPPED_NOTE}</LimitNote>}
      <BackButton href={backHref} />
    </>
  );
};

interface ReadyViewProps {
  claim: Extract<ClaimState, { state: 'ready' }>;
  confirming: boolean;
  switchingAccount: boolean;
  onConfirm: () => void;
  onUseAnotherAccount: () => void;
  backHref?: string;
}

const ReadyView = ({
  claim,
  confirming,
  switchingAccount,
  onConfirm,
  onUseAnotherAccount,
  backHref,
}: ReadyViewProps) => {
  const { credits, payable, rungs, account } = claim;
  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.75 }}>
        <Chip
          variant="soft"
          color="neutral"
          startDecorator={
            <Box aria-hidden sx={{ width: 16, height: 16, borderRadius: '4px', bgcolor: 'success.solidBg' }} />
          }
          sx={{ fontSize: '12px', fontWeight: 600, p: 0 }}
        >
          From BedrockNews Headword
        </Chip>
        <Typography component="h1" sx={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25 }}>
          Claim your Headword credits
        </Typography>
      </Box>

      <Sheet
        variant="soft"
        color="primary"
        data-testid="claim-amount"
        sx={{ p: 2, borderRadius: 'lg', display: 'flex', flexDirection: 'column', gap: 0.25 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography textColor="inherit" sx={{ fontSize: '36px', fontWeight: 800, lineHeight: 1.1 }}>
            {credits}
          </Typography>
          <Typography textColor="inherit" sx={{ fontSize: '16px', fontWeight: 600 }}>
            credits
          </Typography>
        </Box>
        <Typography textColor="inherit" sx={{ fontSize: '14px' }}>
          from BedrockNews Headword
        </Typography>
      </Sheet>

      {payable != null && payable < credits && (
        <LimitNote>
          Your daily limit allows <strong>up to {payable}</strong> today. The rest stays waiting in Headword.
        </LimitNote>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography textColor="text.tertiary" sx={LABEL_SX}>
          Goes to this Bike4Mind account
        </Typography>
        <Sheet variant="outlined" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, borderRadius: 'md' }}>
          <Avatar variant="soft" color="primary" aria-hidden sx={{ width: 36, height: 36, fontWeight: 700 }}>
            {account.charAt(0).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Typography noWrap data-testid="claim-account" sx={{ fontSize: '15px', fontWeight: 600 }}>
              {account}
            </Typography>
            <Typography textColor="text.tertiary" sx={{ fontSize: '13px' }}>
              Signed in to Bike4Mind
            </Typography>
          </Box>
        </Sheet>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography textColor="text.tertiary" sx={LABEL_SX}>
          Solved words ({rungs.length})
        </Typography>
        <List sx={{ '--ListItem-paddingX': '0px', '--ListItem-minHeight': '38px', py: 0 }}>
          {rungs.map((rung, index) => (
            <ListItem
              key={`${rung.date}-${rung.length}`}
              data-testid="claim-rung"
              sx={{
                justifyContent: 'space-between',
                gap: 1.25,
                borderTop: index > 0 ? '1px solid' : 'none',
                borderColor: 'divider',
              }}
            >
              <Typography sx={{ fontSize: '14px' }}>
                <Typography component="span" textColor="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {rung.date}
                </Typography>
                {` \u00b7 ${rung.length}-letter word`}
              </Typography>
              {rung.hard && (
                <Chip size="sm" variant="soft" color="warning" sx={{ fontSize: '12px', fontWeight: 600 }}>
                  Hard mode
                </Chip>
              )}
            </ListItem>
          ))}
        </List>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Button
          data-testid="claim-confirm-btn"
          loading={confirming}
          loadingPosition="start"
          disabled={confirming}
          onClick={onConfirm}
          sx={ACTION_SX}
        >
          {confirming ? 'Adding credits\u2026' : `Add ${credits} credits`}
        </Button>
        <Button
          variant="outlined"
          color="neutral"
          disabled={confirming || switchingAccount}
          onClick={onUseAnotherAccount}
          sx={ACTION_SX}
        >
          Use another account
        </Button>
      </Box>
      <BackLink href={backHref} />
    </>
  );
};

const BedrockNewsClaimPage = () => {
  useDocumentTitle('Claim Headword credits \u00b7 Bike4Mind');
  const navigate = useNavigate();
  const { ticket: searchTicket } = useSearch({ strict: false }) as { ticket?: string };
  const [ticket] = useState(() => takeTicket(searchTicket));
  const { accessToken } = useAccessToken();
  const logoUrl = useGetLogo();
  const logout = useUserLogout();
  const appUrl = useGetSettingsValue('BedrockNewsAppUrl');

  const [view, setView] = useState<View>(
    ticket ? { kind: 'loading' } : { kind: 'claim', claim: { state: 'not-found' } }
  );
  const [account, setAccount] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const didPreview = useRef(false);

  const loadPreview = (claimTicket: string) => {
    setView({ kind: 'loading' });
    postClaim(PREVIEW_URL, claimTicket).then(claim => {
      if (claim.state === 'ready') setAccount(claim.account);
      setView({ kind: 'claim', claim });
    });
  };

  useEffect(() => {
    if (!ticket) return;
    if (!accessToken) {
      // Mid sign-out the URL carries redirectTo and the teardown goes to /login itself; redirecting here nests it.
      if (new URLSearchParams(window.location.search).has('redirectTo')) return;
      navigate({ to: '/login', search: { redirectTo: window.location.pathname } });
      return;
    }
    if (didPreview.current) return;
    didPreview.current = true;
    loadPreview(ticket);
  }, [accessToken, navigate, ticket]);

  // State alone lets a fast double click through before the re-render disables the button.
  const confirm = async () => {
    if (!ticket || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    const claim = await postClaim(REDEEM_URL, ticket);
    setView({ kind: 'claim', claim });
    confirmingRef.current = false;
    setConfirming(false);
  };

  // The logout teardown reads redirectTo from the current URL and sends the user to /login with it.
  const useAnotherAccount = () => {
    const original = window.location.pathname;
    window.history.replaceState(null, '', `${window.location.pathname}?redirectTo=${encodeURIComponent(original)}`);
    logout.mutate(undefined, {
      onError: () => {
        window.history.replaceState(null, '', original);
        setView({ kind: 'claim', claim: { state: 'unavailable' } });
      },
    });
  };

  const backHref = headwordUrl(appUrl, ticket);

  if (view.kind === 'loading') {
    return (
      <ClaimShell logoUrl={logoUrl} busy>
        <Box
          role="status"
          data-testid="claim-loading"
          sx={{
            minHeight: 300,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.75,
          }}
        >
          <CircularProgress color="primary" sx={{ '--CircularProgress-size': '32px' }} />
          <Typography textColor="text.secondary" sx={{ fontSize: '14px', fontWeight: 500 }}>
            Loading your Headword credits&hellip;
          </Typography>
        </Box>
      </ClaimShell>
    );
  }

  const { claim } = view;

  if (claim.state === 'ready') {
    return (
      <ClaimShell logoUrl={logoUrl} busy={confirming}>
        <ReadyView
          claim={claim}
          confirming={confirming}
          switchingAccount={logout.isPending}
          onConfirm={confirm}
          onUseAnotherAccount={useAnotherAccount}
          backHref={backHref}
        />
      </ClaimShell>
    );
  }

  if (claim.state === 'done' || claim.state === 'redeemed') {
    return (
      <ClaimShell logoUrl={logoUrl}>
        <DoneView result={claim.result} account={account} backHref={backHref} />
      </ClaimShell>
    );
  }

  const state: MessageState = claim.state in MESSAGES ? claim.state : 'unavailable';
  const { action } = MESSAGES[state];
  let actionButton: ReactNode;
  if (action === 'verify') {
    actionButton = (
      <Button component={Link} to="/new" data-testid="claim-verify-link" sx={ACTION_SX}>
        Verify your email
      </Button>
    );
  } else if (action === 'retry' && ticket) {
    actionButton = (
      <Button onClick={() => loadPreview(ticket)} sx={ACTION_SX}>
        Try again
      </Button>
    );
  }

  return (
    <ClaimShell logoUrl={logoUrl}>
      <MessageView state={state} action={actionButton} backHref={backHref} />
    </ClaimShell>
  );
};

export default BedrockNewsClaimPage;
