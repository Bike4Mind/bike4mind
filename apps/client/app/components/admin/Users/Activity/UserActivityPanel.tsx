import React, { useMemo, useState } from 'react';
import { Button, Link, Stack, Switch, ToggleButtonGroup, Typography } from '@mui/joy';
import {
  adminAuditLogPath,
  type AuditEntry,
  type AuditLogFilters,
  type UserActivityDirection,
} from '@bike4mind/common';
import { useUserActivity } from '@client/app/hooks/data/adminUserActivity';
import { AuditEntryDrawer, AuditEventTable } from '@client/app/components/admin/AuditLog/shared';
import { UserCreditBalanceChart } from './UserCreditBalanceChart';

const LIST_ERROR_MESSAGE = 'Could not load activity. Refresh to try again.';

const directionFilters = (direction: UserActivityDirection, userId: string): AuditLogFilters =>
  direction === 'target' ? { targetKind: 'user', targetId: userId } : { actorUserId: userId };

/** Admin user view, Activity tab: balance chart plus one direction of the audit trail at a time. */
export const UserActivityPanel: React.FC<{ userId: string }> = ({ userId }) => {
  const [requestedDirection, setRequestedDirection] = useState<UserActivityDirection>('target');
  const [includeSecurity, setIncludeSecurity] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);

  // The target query always runs: its response says whether the actor view exists for this user.
  const targetQuery = useUserActivity(userId, { direction: 'target', includeSecurity });
  const actorViewAvailable = targetQuery.data?.pages[0]?.actorViewAvailable ?? false;
  const direction: UserActivityDirection = actorViewAvailable ? requestedDirection : 'target';
  const actorQuery = useUserActivity(userId, {
    direction: 'actor',
    includeSecurity: false,
    enabled: direction === 'actor',
  });
  const activeQuery = direction === 'target' ? targetQuery : actorQuery;

  const entries = useMemo(() => activeQuery.data?.pages.flatMap(page => page.entries) ?? [], [activeQuery.data]);
  const filters = directionFilters(direction, userId);

  return (
    <Stack spacing={2} sx={{ p: { xs: 1, sm: 2 } }} data-testid="user-activity-panel">
      <UserCreditBalanceChart userId={userId} />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} flexWrap="wrap">
        {actorViewAvailable ? (
          <ToggleButtonGroup
            size="sm"
            value={direction}
            onChange={(_event, value) => {
              if (value) setRequestedDirection(value);
            }}
            data-testid="user-activity-direction"
          >
            <Button value="target" data-testid="user-activity-direction-target-btn">
              Changes to this account
            </Button>
            <Button value="actor" data-testid="user-activity-direction-actor-btn">
              Actions by this user
            </Button>
          </ToggleButtonGroup>
        ) : (
          <Typography level="title-sm">Changes to this account</Typography>
        )}
        {direction === 'target' && (
          <Typography
            component="label"
            level="body-sm"
            startDecorator={
              <Switch
                size="sm"
                checked={includeSecurity}
                onChange={event => setIncludeSecurity(event.target.checked)}
                slotProps={{ input: { 'aria-label': 'Include security events' } }}
                data-testid="user-activity-security-switch"
              />
            }
          >
            Include security events
          </Typography>
        )}
        <Link
          href={adminAuditLogPath(filters)}
          level="body-sm"
          sx={{ ml: { sm: 'auto' } }}
          data-testid="user-activity-open-in-log-link"
        >
          Open in Audit Log
        </Link>
      </Stack>

      <AuditEventTable
        entries={entries}
        isLoading={activeQuery.isLoading}
        errorMessage={activeQuery.isError ? LIST_ERROR_MESSAGE : undefined}
        hasMore={Boolean(activeQuery.hasNextPage)}
        isFetchingMore={activeQuery.isFetchingNextPage}
        onLoadMore={() => void activeQuery.fetchNextPage()}
        onSelectEntry={setSelectedEntry}
        emptyMessage={
          direction === 'target' ? 'No changes recorded for this account.' : 'No admin actions by this user.'
        }
      />
      <AuditEntryDrawer
        entry={selectedEntry}
        onClose={() => setSelectedEntry(null)}
        // Security events live outside the Audit Log, so only admin entries can be opened there.
        openInAuditLogHref={
          selectedEntry?.source === 'admin' ? adminAuditLogPath(filters, selectedEntry.id) : undefined
        }
      />
    </Stack>
  );
};

export default UserActivityPanel;
