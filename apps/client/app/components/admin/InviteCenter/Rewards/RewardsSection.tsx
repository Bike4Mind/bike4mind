import { Button, Stack, Typography } from '@mui/joy';
import { settingsMap, type SettingKey } from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import { ErrorState, LoadingState } from '../../shared';
import { describeDerivedValue } from '../../AdminGrowthPricingTab';
import { REWARD_KEYS } from '../../settingHomes';
import { useOpenSettingHome } from '../../useOpenSettingHome';
import { SettingBlocks, type SettingBlock } from '../shared/SettingBlocks';
import { useStoredByKey } from '../shared/useStoredByKey';

const BLOCKS: readonly SettingBlock[] = [
  {
    id: 'referral',
    title: 'Referral rewards for inviters',
    description:
      'What an inviter earns when an invited friend becomes active or subscribes, plus the hold, starting-invite and alert settings. Payment rewards are held for the hold period, then released; a reward amount of 0 turns that reward off.',
    keys: REWARD_KEYS.referral,
  },
  {
    id: 'gear',
    title: 'Gear rewards',
    description: 'How old an account must be before it can claim a gear reward. 0 lets a new account claim at once.',
    keys: REWARD_KEYS.gear,
  },
];

const derivedValue = (key: SettingKey, stored: unknown) =>
  describeDerivedValue(key, stored ?? settingsMap[key].defaultValue);

export function RewardsSection() {
  const { data, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
  const openSettingHome = useOpenSettingHome();

  const storedByKey = useStoredByKey(data);

  if (isLoading) return <LoadingState label="Loading rewards" testId="invite-center-rewards-loading" />;
  if (isError && !data) {
    return <ErrorState message="Rewards could not be loaded." onRetry={() => void refetch()} retrying={isFetching} />;
  }

  return (
    <Stack gap={2} data-testid="invite-center-rewards">
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <Typography level="body-sm" sx={{ color: 'text.secondary', mr: 1 }}>
          Rewards are paid from the daily trickle pool set in Schedule.
        </Typography>
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="invite-center-rewards-open-schedule-btn"
          onClick={() => openSettingHome({ inviteSection: 'schedule' })}
        >
          Open Schedule
        </Button>
      </Stack>
      <SettingsDraftProvider>
        <SettingBlocks
          blocks={BLOCKS}
          storedByKey={storedByKey}
          testIdPrefix="invite-center-rewards"
          derived={derivedValue}
        />
      </SettingsDraftProvider>
    </Stack>
  );
}
