import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { toast } from 'sonner';
import Alert from '@mui/joy/Alert';
import Typography from '@mui/joy/Typography';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import { isCalendarDate } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { useUser } from '@client/app/contexts/UserContext';

/** Must match ARCHIVE_FOLDER in packages/scripts/migrate/legacyQuestPlanConversion.ts. */
export const QUESTMASTER_ARCHIVE_FOLDER = 'Questmaster archive';

const SHUTDOWN_DATE_SETTING = 'QuestMasterLegacyShutdownDate';
const LEGACY_ROUTES = ['/quests', '/quests-v5'];

/** Formats an admin-set YYYY-MM-DD as a date in UTC, so it never shifts a day in the viewer's zone. */
export function formatShutdownDate(value: string | undefined): string | null {
  if (!value || !isCalendarDate(value)) return null;
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function useLegacyShutdownDate(): string | null {
  const { serverSettings } = useServerSettings();
  const row = serverSettings.find(setting => setting.settingName === SHUTDOWN_DATE_SETTING);
  return formatShutdownDate(typeof row?.settingValue === 'string' ? row.settingValue : undefined);
}

export function retirementMessage(shutdownDate: string | null): string {
  return shutdownDate
    ? `Quest Master v4 and v5 are being retired on ${shutdownDate}.`
    : 'Quest Master v4 and v5 are being retired.';
}

/** Shown at the top of the legacy v4 and v5 quest views. */
export function LegacyQuestmasterBanner() {
  const shutdownDate = useLegacyShutdownDate();
  return (
    <Alert
      data-testid="legacy-questmaster-banner"
      color="warning"
      variant="soft"
      startDecorator={<InfoOutlined />}
      sx={{ mb: 2 }}
    >
      <Typography level="body-sm" data-testid="legacy-questmaster-banner-text">
        {retirementMessage(shutdownDate)} Your plans have been saved as markdown files in the{' '}
        <strong>{QUESTMASTER_ARCHIVE_FOLDER}</strong> folder of your files.
      </Typography>
    </Alert>
  );
}

const seenKey = (userId: string) => `questmaster-archive-notice-seen:${userId}`;

const readSeen = (userId: string): boolean => {
  try {
    return window.localStorage.getItem(seenKey(userId)) === '1';
  } catch {
    return false;
  }
};

const writeSeen = (userId: string) => {
  try {
    window.localStorage.setItem(seenKey(userId), '1');
  } catch {
    // Storage blocked: the notice may show again on a later load, which is harmless.
  }
};

export function archiveNoticeMessage(count: number): string {
  const what =
    count === 1
      ? 'Your Quest Master plan was saved as a markdown file'
      : `Your ${count} Quest Master plans were saved as markdown files`;
  return `${what} in the "${QUESTMASTER_ARCHIVE_FOLDER}" folder of your files.`;
}

/**
 * One-time notice, per device, for a user whose legacy plans were converted. Nothing is rendered.
 * The server is asked only until this device has shown it, and not on the legacy views, whose
 * banner already says it.
 */
export function LegacyQuestmasterNotice() {
  const userId = useUser(s => s.currentUser?.id);
  const { pathname } = useLocation();
  const onLegacyView = LEGACY_ROUTES.includes(pathname);
  const enabled = !!userId && !onLegacyView && !readSeen(userId);
  const announced = useRef(false);

  const { data } = useQuery({
    queryKey: ['questmaster-legacy-archive', userId],
    queryFn: async () => (await api.get<{ archivedCount: number }>('/api/quest-master-plans/legacy-archive')).data,
    enabled,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!userId || !enabled || announced.current || !data || data.archivedCount <= 0) return;
    announced.current = true;
    writeSeen(userId);
    toast.info(archiveNoticeMessage(data.archivedCount), { duration: 15_000 });
  }, [userId, enabled, data]);

  return null;
}
