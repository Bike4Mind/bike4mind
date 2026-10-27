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
import { SignedInPanel } from '../auth/SignedInPanel';
import { useAuthState } from '../auth/useAuthState';
import { ChatShell } from '../chat/ChatShell';
import { AppUpdateNotice } from '../chat/UpdateNotice';
import { isLocalChatActive, setLocalChatActive } from './localChatMode';

export function Home() {
  const state = useAuthState();
  const navigate = useNavigate();
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

  // Signed in, the window belongs to the conversation; identity moves to the sidebar footer. A
  // session that expired under the user keeps it too, mounted in the same place so nothing in it
  // (the composer's draft above all) is torn down while they sign in again.
  if (state?.status === 'signed-in' || state?.reauthRequired || localChat) {
    return (
      <>
        <ChatShell
          key={chatScope.current}
          auth={state}
          account={status =>
            state?.status === 'signed-in' || state?.reauthRequired ? (
              <SignedInPanel state={state} status={status} />
            ) : (
              <Stack spacing={1} sx={{ p: 1.5 }}>
                <Button
                  variant="plain"
                  onClick={() => void navigate({ to: '/settings' })}
                  data-testid="local-chat-settings-btn"
                >
                  Settings
                </Button>
                <Button onClick={() => setLocalChat(false)} data-testid="local-chat-signin-btn">
                  Sign in
                </Button>
              </Stack>
            )
          }
        />
        {state?.reauthRequired && <ReauthNotice state={state} />}
        <AppUpdateNotice />
      </>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.body', p: 3 }}>
      <Card variant="outlined" sx={{ width: 'min(520px, 100%)', gap: 2 }}>
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
          <Button variant="outlined" onClick={() => setLocalChat(true)} data-testid="auth-local-chat-btn">
            Use local models
          </Button>
        )}
      </Card>
      <AppUpdateNotice />
    </Box>
  );
}
