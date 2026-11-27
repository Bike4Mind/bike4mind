import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import { ReauthNotice } from '../auth/ReauthNotice';
import { SignInCard } from '../auth/SignInCard';
import { LocalRailAccount, SignedInRailAccount } from '../auth/RailAccount';
import { useAuthState } from '../auth/useAuthState';
import { ChatShell } from '../chat/ChatShell';
import { AppUpdateNotice } from '../chat/UpdateNotice';
import { useAppUpdate } from '../chat/useAppUpdate';
import { isLocalChatActive, setLocalChatActive } from './localChatMode';
import { centeredScreenSx } from './centeredScreenSx';

export function Home() {
  const state = useAuthState();
  const navigate = useNavigate();
  // One controller for the update card and the account label, so a restart the label asks for and
  // finds work running is confirmed in the card.
  const update = useAppUpdate();
  const [localChat, setLocalChatState] = useState(isLocalChatActive);
  const setLocalChat = (next: boolean) => {
    setLocalChatActive(next);
    setLocalChatState(next);
  };
  // An account can arrive without the local "Sign in" button; a later sign-out must still show the
  // sign-in card, not the local session left behind it.
  const signedIn = state?.status === 'signed-in';
  useEffect(() => {
    if (signedIn) {
      setLocalChatActive(false);
      setLocalChatState(false);
    }
  }, [signedIn]);
  const chatScope = useRef('device-local');
  if (state && state.status !== 'initializing' && !state.reauthRequired) {
    chatScope.current = `${state.environment.url}:${state.user?.id ?? 'device-local'}`;
  }

  // Signed in, the window belongs to the conversation; identity moves to the rail's avatar. A
  // session that expired under the user keeps it too, mounted in the same place so nothing in it
  // (the composer's draft above all) is torn down while they sign in again.
  if (state?.status === 'signed-in' || state?.reauthRequired || localChat) {
    return (
      <>
        <ChatShell
          key={chatScope.current}
          auth={state}
          updateNotice={<AppUpdateNotice controller={update} contained />}
          onOpenModelServers={() =>
            void navigate({ to: '/settings', search: { section: 'models', setting: 'model-servers' } })
          }
          onOpenImportSettings={focus =>
            void navigate({ to: '/settings', search: { section: 'privacy', setting: 'claude-import', focus } })
          }
          account={context =>
            state?.status === 'signed-in' || state?.reauthRequired ? (
              <SignedInRailAccount state={state} update={update} context={context} />
            ) : (
              <LocalRailAccount context={context} onSignIn={() => setLocalChat(false)} />
            )
          }
        />
        {state?.reauthRequired && <ReauthNotice state={state} />}
      </>
    );
  }

  return (
    <Box
      sx={{
        ...centeredScreenSx,
        background: 'radial-gradient(ellipse at 50% 35%, var(--joy-palette-primary-softBg) 0%, transparent 65%)',
      }}
    >
      <Card
        variant="outlined"
        sx={{
          width: 'min(440px, 100%)',
          gap: 2,
          p: { xs: 3, sm: 4 },
          borderRadius: 'lg',
          boxShadow: 'lg',
          bgcolor: 'background.surface',
        }}
      >
        {!state || state.status === 'initializing' ? (
          <Stack direction="row" spacing={1.5} alignItems="center" data-testid="auth-loading-stack">
            <CircularProgress size="sm" />
            <Typography level="body-sm" textColor="text.tertiary">
              Checking your saved sign-in...
            </Typography>
          </Stack>
        ) : (
          <SignInCard state={state} />
        )}
        {(state?.status === 'signed-out' || state?.status === 'unconfigured') && (
          <Button variant="plain" color="neutral" onClick={() => setLocalChat(true)} data-testid="auth-local-chat-btn">
            Use local models
          </Button>
        )}
      </Card>
      <AppUpdateNotice controller={update} />
    </Box>
  );
}
