import React, { useMemo, useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import { type AuditEntry, type ILoginRecord } from '@bike4mind/common';
import { useUserActivity } from '@client/app/hooks/data/adminUserActivity';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { DataTable, RelativeTime, SectionCard, type DataColumn } from '../../../shared';
import { AuditTimeline } from './AuditTimeline';
import type { AdminUserProfile } from '../userProfileModel';

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

type SignInRow = ILoginRecord & { id: string };

const SIGN_IN_COLUMNS: readonly DataColumn<SignInRow>[] = [
  { id: 'when', label: 'When', render: row => <RelativeTime at={row.loginTime} /> },
  { id: 'location', label: 'Location', render: row => row.location || '-' },
  {
    id: 'device',
    label: 'Device',
    render: row => [row.browser, row.operatingSystem].filter(Boolean).join(' on ') || '-',
  },
  { id: 'type', label: 'Type', render: row => row.deviceType || '-' },
  {
    id: 'ip',
    label: 'IP address',
    render: row => (
      <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
        {row.ip || '-'}
      </Box>
    ),
  },
];

/** Successful sign-ins recorded on the user; blocked attempts live in the security events of Activity. */
export const SignInsTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const rows = useMemo<SignInRow[]>(
    () =>
      [...(user.loginRecords ?? [])]
        .sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime())
        .map((record, index) => ({ ...record, id: `${new Date(record.loginTime).getTime()}-${index}` })),
    [user.loginRecords]
  );
  return (
    <SectionCard
      title="Sign-ins"
      body="custom"
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Successful sign-ins
        </Typography>
      }
      data-testid="user-profile-sign-ins"
    >
      <DataTable
        rows={rows}
        columns={SIGN_IN_COLUMNS}
        getRowId={row => row.id}
        label="Sign-ins"
        onRetry={() => undefined}
        empty={<Empty>No sign-ins recorded.</Empty>}
        testId="user-profile-sign-in-table"
      />
    </SectionCard>
  );
};

/** Admin-made changes to this account, newest first; a row opens the full audit entry. */
export const AdminLogTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const activity = useUserActivity(user.id, { direction: 'target', includeSecurity: false });
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const entries = useMemo(
    () => activity.data?.pages.flatMap(page => page.entries).filter(entry => entry.source === 'admin') ?? [],
    [activity.data]
  );

  const body = () => {
    if (activity.isLoading) return <Empty>Loading...</Empty>;
    if (activity.isError) return <Empty>The admin log could not be loaded.</Empty>;
    // Filtering happens after paging, so an empty page proves nothing while older pages remain.
    if (entries.length === 0)
      return (
        <Empty>
          {activity.hasNextPage
            ? 'No admin changes in the latest activity. Load more to check older entries.'
            : 'No admin has changed this account yet.'}
        </Empty>
      );
    return <AuditTimeline entries={entries} onSelect={setSelected} data-testid="user-profile-admin-log-list" />;
  };

  return (
    <>
      <SectionCard title="Admin actions on this account" body="custom" data-testid="user-profile-admin-log">
        {body()}
        {activity.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
              data-testid="user-profile-admin-log-more-btn"
            >
              Load more
            </Button>
          </Box>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
};
