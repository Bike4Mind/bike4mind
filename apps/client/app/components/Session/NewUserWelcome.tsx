import { useCallback, useState } from 'react';
import { Box, Button, IconButton, Sheet, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOwnSessions } from '@client/app/hooks/data/sessions';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import useChatActions from '@client/app/hooks/useChatActions';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { APP_NAME, getBrandName } from '@client/config/general';
import { STARTER_PROMPTS, shouldShowNewUserWelcome, welcomeCreditsLine } from './newUserWelcomeModel';

const dismissKey = (userId: string) => `newUserWelcomeDismissed:${userId}`;

function readDismissed(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(dismissKey(userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * First-run card on the empty New Chat splash: starting credits plus three prompts that send
 * immediately. Shown only while the user owns no notebooks, so it disappears for good after the
 * first chat and never interrupts a returning user.
 */
const NewUserWelcome = () => {
  const { currentUser } = useUser();
  const userId = currentUser?.id;
  const { data: sessions, isSuccess, isFetching } = useGetOwnSessions('');
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const defaultFreeCredits = Number(useGetSettingsValue('defaultFreeCredits')) || 0;
  const balance = useEffectiveCredits();
  const sendPrompt = useChatActions(s => s.sendPrompt);
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const requestFocus = useChatInput(s => s.requestFocus);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [sending, setSending] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (!userId) return;
    try {
      localStorage.setItem(dismissKey(userId), '1');
    } catch {
      // Private mode / full storage: the card still hides for this visit.
    }
  }, [userId]);

  const start = useCallback(
    async (prompt: string) => {
      // No composer mounted to send through (should not happen on /new): prefill instead.
      if (!sendPrompt) {
        setChatInputValue(prompt);
        requestFocus();
        return;
      }
      setSending(true);
      try {
        const sent = await sendPrompt(prompt, { respectBlockedState: true });
        if (!sent) setChatInputValue(prompt);
      } finally {
        setSending(false);
      }
    },
    [sendPrompt, setChatInputValue, requestFocus]
  );

  const show = shouldShowNewUserWelcome({
    sessionsLoaded: isSuccess && !isFetching,
    sessionCount: sessions?.pages?.[0]?.data?.length ?? 0,
    dismissed,
  });
  if (!show) return null;

  const awaitingVerification =
    currentUser?.emailVerified === false && (currentUser?.tags ?? []).includes(PENDING_FREE_CREDITS_TAG);
  const creditsLine = welcomeCreditsLine({
    enforceCredits,
    balance,
    awaitingVerification,
    pendingGrant: currentUser?.pendingCreditGrant ?? defaultFreeCredits,
  });

  return (
    <Sheet
      variant="outlined"
      data-testid="new-user-welcome"
      sx={{
        position: 'relative',
        width: '100%',
        maxWidth: '680px',
        borderRadius: '12px',
        p: { xs: 2, sm: 2.5 },
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        textAlign: 'left',
        backgroundColor: 'background.surface',
      }}
    >
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Dismiss welcome"
        data-testid="new-user-welcome-dismiss"
        onClick={dismiss}
        sx={{ position: 'absolute', top: 8, right: 8 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      <Typography level="title-lg" sx={{ pr: 4 }}>
        {APP_NAME ? `Welcome to ${getBrandName()}` : 'Welcome'}
      </Typography>
      {creditsLine && (
        <Typography level="body-md" data-testid="new-user-welcome-credits">
          {creditsLine}
        </Typography>
      )}
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        Pick a prompt to start your first chat, or type your own below.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        {STARTER_PROMPTS.map((p, i) => (
          <Button
            key={p.title}
            variant="outlined"
            color="neutral"
            disabled={sending}
            data-testid={`new-user-welcome-prompt-${i}`}
            onClick={() => void start(p.prompt)}
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              justifyContent: 'flex-start',
              gap: 0.5,
              py: 1.25,
              textAlign: 'left',
              whiteSpace: 'normal',
              fontWeight: 400,
            }}
          >
            <Typography level="title-sm">{p.title}</Typography>
            <Box component="span" sx={{ fontSize: '13px', lineHeight: 1.4, color: 'text.secondary' }}>
              {p.prompt}
            </Box>
          </Button>
        ))}
      </Stack>
    </Sheet>
  );
};

export default NewUserWelcome;
