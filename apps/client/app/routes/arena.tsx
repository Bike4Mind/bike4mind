import { useRef, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { ArenaChoice, ArenaPairView } from '@bike4mind/common';
import { ArenaMarkdown } from '@client/app/components/PreferenceArena/ArenaMarkdown';
import { useBillingView } from '@client/app/components/subscription/BillingDeepLinkModals';
import { useArenaNextPair, useArenaVote } from '@client/app/hooks/data/preferenceArena';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { getErrorMessage } from '@client/app/utils/error';

const VOTE_BUTTONS: ReadonlyArray<{ choice: ArenaChoice; label: string }> = [
  { choice: 'a', label: 'A is better' },
  { choice: 'tie', label: 'Tie' },
  { choice: 'b', label: 'B is better' },
];

function formatVoteToast(creditsAwarded: number): string {
  if (creditsAwarded <= 0) return 'Thanks for your feedback';
  return creditsAwarded === 1 ? '+1 credit' : `+${creditsAwarded} credits`;
}

function AnswerCard({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <Sheet
      variant="outlined"
      data-testid={testId}
      sx={{ flex: 1, minWidth: 0, p: 2, borderRadius: 'lg', display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Typography level="title-md">{label}</Typography>
      <ArenaMarkdown text={text} />
    </Sheet>
  );
}

function PairView({
  pair,
  submitting,
  onVote,
}: {
  pair: ArenaPairView;
  submitting: boolean;
  onVote: (choice: ArenaChoice) => void;
}) {
  return (
    <Stack gap={2} data-testid="arena-pair">
      <Sheet variant="soft" sx={{ p: 2, borderRadius: 'lg' }} data-testid="arena-prompt">
        <Typography level="body-xs" sx={{ mb: 0.5 }}>
          Prompt
        </Typography>
        <ArenaMarkdown text={pair.prompt} />
      </Sheet>
      <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems="stretch">
        <AnswerCard label="Answer A" text={pair.answerA} testId="arena-answer-a" />
        <AnswerCard label="Answer B" text={pair.answerB} testId="arena-answer-b" />
      </Stack>
      <Typography level="body-sm">Which answer is better?</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        {VOTE_BUTTONS.map(({ choice, label }) => (
          <Button
            key={choice}
            variant={choice === 'tie' ? 'outlined' : 'solid'}
            color="neutral"
            disabled={submitting}
            loading={submitting}
            onClick={() => onVote(choice)}
            data-testid={`arena-vote-${choice}-btn`}
          >
            {label}
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}

function Notice({ title, children, testId }: { title: string; children?: ReactNode; testId: string }) {
  return (
    <Sheet variant="soft" sx={{ p: 3, borderRadius: 'lg' }} data-testid={testId}>
      <Typography level="title-md">{title}</Typography>
      {children}
    </Sheet>
  );
}

export default function ArenaPage() {
  useDocumentTitle('Rate answers');
  const { data, isPending, isError, error, isFetching, refetch } = useArenaNextPair();
  const vote = useArenaVote();
  const { openView: openBillingView } = useBillingView();
  // The billing modal that hosts the verification flow only mounts when credits are enforced, and
  // its unlock card renders nothing unless the no-card unlock is on.
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const noCardUnlockEnabled = !!useGetSettingsValue('noCardUnlockEnabled');
  const canOpenVerification = enforceCredits && noCardUnlockEnabled;

  const voteInFlight = useRef(false);

  const submitVote = (pairId: string, choice: ArenaChoice) => {
    // A second click can land before isPending re-renders the buttons disabled.
    if (voteInFlight.current) return;
    voteInFlight.current = true;
    vote.mutate(
      { pairId, choice },
      {
        onSettled: () => {
          voteInFlight.current = false;
        },
        onSuccess: result => {
          toast.success(formatVoteToast(result.creditsAwarded));
          void refetch();
        },
        onError: voteError => {
          toast.error(getErrorMessage(voteError));
          void refetch();
        },
      }
    );
  };

  const renderBody = () => {
    if (isPending) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }} data-testid="arena-loading">
          <CircularProgress />
        </Box>
      );
    }
    if (isError) {
      return (
        <Alert color="danger" data-testid="arena-error">
          <Stack gap={1} alignItems="flex-start">
            <Typography level="body-sm">{getErrorMessage(error)}</Typography>
            <Button size="sm" variant="outlined" color="danger" onClick={() => void refetch()}>
              Try again
            </Button>
          </Stack>
        </Alert>
      );
    }
    if (data.status === 'ready') {
      return (
        <PairView
          pair={data.pair}
          submitting={vote.isPending || isFetching}
          onVote={choice => submitVote(data.pair.pairId, choice)}
        />
      );
    }
    if (data.status === 'empty') {
      return <Notice title="No comparisons right now, check back later" testId="arena-empty" />;
    }
    if (data.reason === 'unverified') {
      return (
        <Notice title="Only verified accounts can take part" testId="arena-unverified">
          <Typography level="body-sm" sx={{ mt: 0.5, mb: 1.5 }}>
            Verify your account to share your feedback on answers and earn credits.
          </Typography>
          {canOpenVerification && (
            <Button size="sm" onClick={() => openBillingView('credits')} data-testid="arena-unverified-verify-btn">
              Verify your account
            </Button>
          )}
        </Notice>
      );
    }
    return <Notice title="This isn't available right now" testId="arena-unavailable" />;
  };

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', p: { xs: 2, md: 3 }, width: '100%', overflowY: 'auto' }}>
      <Stack gap={0.5} sx={{ mb: 2 }}>
        <Typography level="h3">Rate answers, earn credits</Typography>
        <Typography level="body-sm">
          Share your feedback on which of two answers is better. Some votes earn promotional credits.
        </Typography>
      </Stack>
      {renderBody()}
      <Typography level="body-xs" sx={{ mt: 3 }} data-testid="arena-footer-note">
        Answers come from AI models and may be wrong. Prompts are synthetic or shared with consent. Credits are
        promotional, capped, and have no cash value.
      </Typography>
    </Box>
  );
}
