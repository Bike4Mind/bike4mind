import { useMemo } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { settingsMap, type SettingKey } from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import { ErrorState, LoadingState, SettingsSection } from '../../shared';
import { describeDerivedValue } from '../../AdminGrowthPricingTab';
import { REWARD_KEYS } from '../../settingHomes';
import { useOpenSettingHome } from '../../useOpenSettingHome';
import { SettingKeyRow } from '../shared/SettingKeyRow';

const BLOCKS: ReadonlyArray<{ id: string; title: string; description: string; keys: readonly SettingKey[] }> = [
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

export function RewardsSection() {
  const { data, isLoading, isError, isFetching, refetch } = useSettingsFromServer();
  const openSettingHome = useOpenSettingHome();

  const storedByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.settingName, row.settingValue);
    return map;
  }, [data]);

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
        <Stack gap={2}>
          {BLOCKS.map(block => (
            <SettingsSection
              key={block.id}
              component="section"
              sx={{ mb: 0 }}
              data-testid={`invite-center-rewards-block-${block.id}`}
            >
              <Stack sx={{ gap: 0.5, mb: 2 }}>
                <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
                  {block.title}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  {block.description}
                </Typography>
              </Stack>
              <Stack sx={{ gap: 1 }}>
                {block.keys.map((key, index) => {
                  const stored = storedByKey.get(key);
                  return (
                    <SettingKeyRow
                      key={key}
                      settingKey={key}
                      stored={stored}
                      index={index}
                      testIdPrefix="invite-center-rewards"
                      derived={describeDerivedValue(key, stored ?? settingsMap[key].defaultValue)}
                    />
                  );
                })}
              </Stack>
            </SettingsSection>
          ))}
        </Stack>
      </SettingsDraftProvider>
    </Stack>
  );
}
