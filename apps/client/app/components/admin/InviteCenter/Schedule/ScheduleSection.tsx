import { useMemo } from 'react';
import { Alert, Stack, Typography } from '@mui/joy';
import WarningIcon from '@mui/icons-material/Warning';
import type { SettingKey } from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import { ErrorState, LoadingState, SettingsSection } from '../../shared';
import { FREE_TIER_LIMIT_KEYS, SCHEDULE_KEYS } from '../../settingHomes';
import { SettingKeyRow } from '../shared/SettingKeyRow';
import {
  INVITE_SEND_LIMITS_LIVE,
  describeNewAccountGrant,
  dripCapWarning,
  inviteBonusWarning,
  readScheduleValues,
} from './scheduleSummary';

const BLOCKS: ReadonlyArray<{ id: string; title: string; description: string; keys: readonly SettingKey[] }> = [
  {
    id: 'signup',
    title: 'Signup schedule',
    description:
      'What a verified new account receives up front and per active day, the extra for invited accounts, and the daily pools those grants draw from.',
    keys: SCHEDULE_KEYS,
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

  const storedByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.settingName, row.settingValue);
    return map;
  }, [data]);

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
          {`The drip cap (${values.signupGrantDripCap?.toLocaleString('en-US')}) is below the daily credits (${values.signupGrantDailyCredits?.toLocaleString('en-US')}), so the drip stops before paying one full day's amount.`}
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
        <Stack gap={2}>
          {BLOCKS.map(block => (
            <SettingsSection
              key={block.id}
              component="section"
              sx={{ mb: 0 }}
              data-testid={`invite-center-schedule-block-${block.id}`}
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
                {block.keys.map((key, index) => (
                  <SettingKeyRow
                    key={key}
                    settingKey={key}
                    stored={storedByKey.get(key)}
                    index={index}
                    testIdPrefix="invite-center-schedule"
                  />
                ))}
              </Stack>
            </SettingsSection>
          ))}
        </Stack>
      </SettingsDraftProvider>
    </Stack>
  );
}
