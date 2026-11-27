import { useMemo } from 'react';
import { Alert, Stack, Typography } from '@mui/joy';
import WarningIcon from '@mui/icons-material/Warning';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import { ErrorState, LoadingState } from '../../shared';
import { FREE_TIER_LIMIT_KEYS, SIGNUP_SCHEDULE_KEYS, SIGNUP_TIMING_KEYS } from '../../settingHomes';
import { SettingBlocks, type SettingBlock } from '../shared/SettingBlocks';
import { useStoredByKey } from '../shared/useStoredByKey';
import { useStageHiddenSettingKeys } from '../../useStageHiddenSettingKeys';
import {
  INVITE_SEND_LIMITS_LIVE,
  describeNewAccountGrant,
  dripCapWarning,
  inviteBonusWarning,
  readScheduleValues,
} from './scheduleSummary';

const BLOCKS: readonly SettingBlock[] = [
  {
    id: 'signup',
    title: 'Signup schedule',
    description:
      'What a verified new account receives up front and per active day, the extra for invited accounts, and the daily pools those grants draw from.',
    keys: SIGNUP_SCHEDULE_KEYS,
  },
  {
    id: 'timing',
    title: 'Activity and payment unlock',
    description:
      'Qualifying active time for each drip and the settlement hold before a payment unlocks the remaining credits.',
    keys: SIGNUP_TIMING_KEYS,
  },
  {
    id: 'free-tier',
    title: 'Free-tier limits',
    description: 'Daily spend caps for free accounts: the first day, days 2 to 7, and every day after.',
    keys: FREE_TIER_LIMIT_KEYS,
  },
];

export function ScheduleSection() {
  const { data, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
  const hiddenKeys = useStageHiddenSettingKeys();
  const blocks = useMemo(
    () => BLOCKS.map(block => ({ ...block, keys: block.keys.filter(key => !hiddenKeys.has(key)) })),
    [hiddenKeys]
  );

  const storedByKey = useStoredByKey(data);

  // Saved values, not drafts: the summary and warnings describe what is live.
  const values = useMemo(() => readScheduleValues(storedByKey), [storedByKey]);

  if (isLoading) return <LoadingState label="Loading the signup schedule" testId="invite-center-schedule-loading" />;
  if (isError && !data) {
    return (
      <ErrorState
        message="The signup schedule could not be loaded."
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  return (
    <Stack gap={2} data-testid="invite-center-schedule">
      <Typography level="body-md" data-testid="invite-center-schedule-summary">
        {describeNewAccountGrant(values)}
      </Typography>
      {dripCapWarning(values) && (
        <Alert
          color="warning"
          variant="soft"
          startDecorator={<WarningIcon />}
          data-testid="invite-center-schedule-drip-warning"
        >
          {`The drip cap (${values.signupGrantDripCap.toLocaleString('en-US')}) is below the daily credits (${values.signupGrantDailyCredits.toLocaleString('en-US')}), so the drip stops before paying one full day's amount.`}
        </Alert>
      )}
      {inviteBonusWarning(values, INVITE_SEND_LIMITS_LIVE) && (
        <Alert
          color="warning"
          variant="soft"
          startDecorator={<WarningIcon />}
          data-testid="invite-center-schedule-invite-bonus-warning"
        >
          Each invited account gets the invite bonus, and invite sending has no per-sender limit yet, so the bonus is
          not capped per inviter.
        </Alert>
      )}
      <SettingsDraftProvider>
        <SettingBlocks blocks={blocks} storedByKey={storedByKey} testIdPrefix="invite-center-schedule" />
      </SettingsDraftProvider>
    </Stack>
  );
}
