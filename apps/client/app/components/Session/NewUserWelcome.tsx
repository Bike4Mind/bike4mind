import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, Link, Sheet, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import { FirstRunEvents } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOwnSessions } from '@client/app/hooks/data/sessions';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useSignupGrantCredits } from '@client/app/hooks/useSignupGrantCredits';
import { useSignupGrantSchedule } from '@client/app/hooks/useSignupGrantSchedule';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useSelectedModelAnswerCost } from '@client/app/hooks/useSelectedModelAnswerCost';
import { formatAnswersEstimate } from '@client/app/utils/creditEstimate';
import useChatActions from '@client/app/hooks/useChatActions';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { APP_NAME, getBrandName } from '@client/config/general';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import {
  STARTER_PROMPTS,
  advertisedDripCredits,
  shouldShowNewUserWelcome,
  welcomeCanStart,
  welcomeCreditsLine,
} from './newUserWelcomeModel';
import { isAwaitingEmailVerification } from '@client/app/utils/onboarding';
import { claimFirstRunImpression } from '@client/app/utils/firstRunImpression';
import SignupGrantStatus from '../subscription/SignupGrantStatus';

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
  const defaultFreeCredits = useSignupGrantCredits();
  const schedule = useSignupGrantSchedule();
  const minActiveSeconds = useGetSettingsValue('signupGrantActivityMinActiveSeconds');
  const dailyDripCredits = advertisedDripCredits({
    enabled: schedule.dailyCredits > 0,
    dailyCredits: schedule.dailyCredits,
    unlockCredits: currentUser?.signupGrant?.unlockCredits,
  });
  const balance = useEffectiveCredits();
  const liveBalance = useEffectiveCredits({ live: true });
  const answerCost = useSelectedModelAnswerCost();
  const sendPrompt = useChatActions(s => s.sendPrompt);
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const requestFocus = useChatInput(s => s.requestFocus);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [sending, setSending] = useState(false);
  const { mutate: logEvent } = useLogEvent();
  const shownRef = useRef(false);

  const dismiss = useCallback(() => {
    logEvent({ type: FirstRunEvents.WELCOME_CARD_DISMISSED });
    setDismissed(true);
    if (!userId) return;
    try {
      localStorage.setItem(dismissKey(userId), '1');
    } catch {
      // Private mode / full storage: the card still hides for this visit.
    }
  }, [userId, logEvent]);

  const start = useCallback(
    async (prompt: string) => {
      const starter = STARTER_PROMPTS.findIndex(item => item.prompt === prompt);
      logEvent({ type: FirstRunEvents.WELCOME_CARD_CLICKED, metadata: { action: 'starter' } });
      // No composer mounted to send through (should not happen on /new): prefill instead.
      if (!sendPrompt) {
        setChatInputValue(prompt);
        requestFocus();
        return;
      }
      setSending(true);
      try {
        const sent = await sendPrompt(prompt, { respectBlockedState: true });
        if (sent) logEvent({ type: FirstRunEvents.STARTER_USED, metadata: { starter } });
        else setChatInputValue(prompt);
      } finally {
        setSending(false);
      }
    },
    [sendPrompt, setChatInputValue, requestFocus, logEvent]
  );

  const show = shouldShowNewUserWelcome({
    sessionsLoaded: isSuccess && !isFetching,
    sessionCount: sessions?.pages?.[0]?.data?.length ?? 0,
    dismissed,
  });
  useEffect(() => {
    if (!show || shownRef.current) return;
    shownRef.current = true;
    if (!claimFirstRunImpression(FirstRunEvents.WELCOME_CARD_SHOWN, userId)) return;
    logEvent({ type: FirstRunEvents.WELCOME_CARD_SHOWN });
    logEvent({ type: FirstRunEvents.ZERO_STATE_SHOWN, metadata: { surface: 'new_chat' } });
  }, [show, userId, logEvent]);
  if (!show) return null;

  const awaitingVerification = isAwaitingEmailVerification(currentUser);
  const canStart = welcomeCanStart({ enforceCredits, balance: liveBalance });
  const creditsLine = welcomeCreditsLine({
    enforceCredits,
    balance,
    awaitingVerification,
    pendingGrant: currentUser?.signupGrant?.signupCredits ?? currentUser?.pendingCreditGrant ?? defaultFreeCredits,
    pendingGrantIsMaximum: !!currentUser?.signupGrant,
    dailyDripCredits,
    minActiveSeconds,
  });
  // Same credits the line above quotes: the pending grant before verification, else the displayed balance.
  const estimateCredits = awaitingVerification
    ? (currentUser?.signupGrant?.signupCredits ?? currentUser?.pendingCreditGrant ?? defaultFreeCredits)
    : balance;
  const answersEstimate =
    creditsLine && !(awaitingVerification && currentUser?.signupGrant)
      ? formatAnswersEstimate(estimateCredits, answerCost)
      : null;

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
      <SignupGrantStatus />
      {answersEstimate && (
        <Typography level="body-sm" data-testid="new-user-welcome-answers-estimate" sx={{ color: 'text.secondary' }}>
          {answersEstimate}
        </Typography>
      )}
      {!canStart && !creditsLine && (
        <Typography level="body-sm" data-testid="new-user-welcome-out-of-credits">
          You&apos;re out of credits.
        </Typography>
      )}
      {canStart && (
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Pick a prompt to start your first chat, or type your own below.
        </Typography>
      )}
      {canStart && (
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
      )}
      <Link
        level="body-xs"
        href={ExternalLinks.privacy}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="new-user-welcome-privacy-link"
        onClick={() => logEvent({ type: FirstRunEvents.WELCOME_CARD_CLICKED, metadata: { action: 'data_handling' } })}
        sx={{ alignSelf: 'flex-start', color: 'text.tertiary' }}
      >
        How your data is handled
      </Link>
    </Sheet>
  );
};

export default NewUserWelcome;
