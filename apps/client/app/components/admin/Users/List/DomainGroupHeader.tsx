import { Box, Button, Stack, Typography } from '@mui/joy';
import type { EmailDomainGroup } from '@client/app/utils/signupAnomaly';
import { SIGNUP_SIGNAL_LABELS } from '@client/app/utils/signupSignals';
import { StatusChip } from '../../shared/StatusChip';
import { adminFocus } from '../../shared/adminStyles';
import { parseDomain } from '../usersTabSearch';

/** How tightly the group's accounts were created, e.g. "created within 4 min". */
export function creationSpread(group: Pick<EmailDomainGroup, 'firstCreatedAt' | 'lastCreatedAt'>): string {
  const minutes = Math.max(0, (Date.parse(group.lastCreatedAt) - Date.parse(group.firstCreatedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'created within a minute';
  if (minutes < 120) return `created within ${Math.ceil(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `created within ${Math.ceil(hours)} h`;
  return `created over ${Math.ceil(hours / 24)} days`;
}

/** The band above one email domain's rows when the list is grouped. */
export function DomainGroupHeader({
  group,
  filtered,
  onFilter,
}: {
  group: EmailDomainGroup;
  /** The list is already narrowed to this domain. */
  filtered: boolean;
  onFilter: () => void;
}) {
  const facts = [
    `${group.count.toLocaleString()} ${group.count === 1 ? 'user' : 'users'}`,
    creationSpread(group),
    `${group.apiKeyCount.toLocaleString()} API ${group.apiKeyCount === 1 ? 'key' : 'keys'}`,
  ].filter(Boolean);
  return (
    <Stack
      direction="row"
      alignItems="center"
      flexWrap="wrap"
      gap={1.25}
      data-testid={`admin-users-group-${group.domain}`}
      sx={{
        minHeight: 44,
        px: 1.5,
        py: 0.75,
        bgcolor: 'admin.surfaceSubtle',
        boxShadow: theme =>
          group.signals.length > 0 ? `inset 3px 0 0 ${theme.vars.palette.admin.status.warn.foreground}` : 'none',
      }}
    >
      <Typography sx={{ color: 'admin.ink', fontWeight: 700, fontSize: 13 }}>{group.domain}</Typography>
      <Typography sx={{ color: 'admin.inkSecondary', fontSize: 12 }}>{facts.join(' \u00b7 ')}</Typography>
      {group.signals.map(signal => (
        <Box
          key={signal}
          component="span"
          title={`${SIGNUP_SIGNAL_LABELS[signal].description} Review before taking action.`}
        >
          <StatusChip
            tone="bad"
            dot
            label={SIGNUP_SIGNAL_LABELS[signal].label}
            data-testid={`admin-users-group-${group.domain}-signal-${signal}`}
          />
        </Box>
      ))}
      {/* The "(unknown)" bucket has no domain the filter can carry. */}
      {!filtered && parseDomain(group.domain) && (
        <Button
          size="sm"
          variant="plain"
          onClick={onFilter}
          data-testid={`admin-users-group-${group.domain}-filter-btn`}
          sx={{ ...adminFocus, ml: 'auto', minHeight: 28, fontSize: 12, color: 'admin.link' }}
        >
          Show only this domain
        </Button>
      )}
    </Stack>
  );
}
