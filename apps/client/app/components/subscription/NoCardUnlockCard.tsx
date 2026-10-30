import { Alert, Box, Button, Link, Typography } from '@mui/joy';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from '@tanstack/react-router';
import type { NoCardUnlockReason, NoCardUnlockRefusal } from '@bike4mind/common';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useNoCardUnlock } from '@client/app/hooks/data/noCardUnlock';

const REFUSAL_TEXT: Record<NoCardUnlockRefusal, string> = {
  disabled: 'This unlock is not available for your account right now.',
  github_not_linked: 'Connect your GitHub account first, then try again.',
  github_reauthorize_required: 'Reconnect GitHub to share your verified email, then try again.',
  github_rate_limited: 'GitHub is limiting requests right now. Try again in a few minutes.',
  github_too_new: 'This GitHub account is too new to qualify.',
  github_few_repos: 'This GitHub account does not have enough public activity to qualify.',
  github_email_unverified: 'This GitHub account has no verified email.',
  github_already_claimed: 'This GitHub account has already been used for an unlock.',
  work_email_free: 'Use a work email address instead of a personal one.',
  work_email_disposable: 'Disposable email addresses do not qualify.',
  work_email_no_mx: 'This email domain cannot receive mail.',
  work_email_catch_all: 'This email domain could not be verified as a work address.',
  work_email_probe_inconclusive: 'We could not verify this email domain right now.',
  domain_cap_reached: 'Too many unlocks have been claimed for this domain today. Try again tomorrow.',
  signup_held: 'Unlocks for your email domain are on hold while we review recent signups.',
  signup_grant_pending: 'Your signup credits are still being prepared. Unlocks open once they arrive.',
  daily_budget_reached: 'Free credit unlocks are paused for today. Try again tomorrow.',
  cap_reached: 'You have already unlocked the maximum available.',
  inbox_already_claimed: 'Free credits have already been claimed for this email inbox.',
  already_granted: 'This unlock has already been applied to your account.',
};

export function NoCardUnlockCard() {
  const { t } = useTranslation();
  const { getSettingBoolean } = useAdminSettingsCache();
  const unlock = useNoCardUnlock();
  const [pending, setPending] = useState<NoCardUnlockReason | null>(null);
  const [outcome, setOutcome] = useState<{ granted: number; refusal?: NoCardUnlockRefusal } | null>(null);
  const [failed, setFailed] = useState(false);

  if (!getSettingBoolean('noCardUnlockEnabled', false)) return null;
  // No catch-all probe runs in this deployment, so work-email unlocks are only offered when inconclusive results are allowed.
  const workEmailOffered = getSettingBoolean('noCardUnlockProbeInconclusiveAllows', false);

  const run = (reason: NoCardUnlockReason) => {
    setPending(reason);
    setOutcome(null);
    setFailed(false);
    unlock.mutate(reason, {
      onSuccess: result => setOutcome({ granted: result.creditsGranted, refusal: result.refusal }),
      onError: () => setFailed(true),
      onSettled: () => setPending(null),
    });
  };

  return (
    <Box data-testid="no-card-unlock-card" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography level="title-md">{t('billing.no_card_unlock_title', 'Unlock credits without a card')}</Typography>
      <Typography level="body-sm">
        {workEmailOffered
          ? t('billing.no_card_unlock_sub', 'Verify a GitHub account or a work email to add starter credits.')
          : t('billing.no_card_unlock_sub_github', 'Verify a GitHub account to add starter credits.')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          data-testid="no-card-unlock-github-btn"
          variant="outlined"
          loading={pending === 'github_verified'}
          disabled={pending !== null}
          onClick={() => run('github_verified')}
        >
          {t('billing.no_card_unlock_github', 'Verify with GitHub')}
        </Button>
        {workEmailOffered && (
          <Button
            data-testid="no-card-unlock-work-email-btn"
            variant="outlined"
            loading={pending === 'work_email_verified'}
            disabled={pending !== null}
            onClick={() => run('work_email_verified')}
          >
            {t('billing.no_card_unlock_work_email', 'Verify work email')}
          </Button>
        )}
      </Box>
      {failed && (
        <Alert data-testid="no-card-unlock-error" color="danger">
          {t('billing.no_card_unlock_error', 'Something went wrong. Please try again.')}
        </Alert>
      )}
      {outcome && !outcome.refusal && outcome.granted > 0 && (
        <Alert data-testid="no-card-unlock-success" color="success">
          {t('billing.no_card_unlock_success', 'Credits unlocked and added to your balance.')}
        </Alert>
      )}
      {outcome?.refusal && (
        <Alert data-testid="no-card-unlock-refusal" color="warning">
          <Box>
            <Typography level="body-sm">
              {t(`billing.no_card_unlock_refusal_${outcome.refusal}`, REFUSAL_TEXT[outcome.refusal])}
            </Typography>
            {(outcome.refusal === 'github_reauthorize_required' || outcome.refusal === 'github_not_linked') && (
              <Link data-testid="no-card-unlock-integrations-link" component={RouterLink} to="/integrations">
                {t('billing.no_card_unlock_integrations', 'Open Integrations')}
              </Link>
            )}
          </Box>
        </Alert>
      )}
    </Box>
  );
}
