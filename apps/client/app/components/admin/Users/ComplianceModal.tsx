import { useMemo } from 'react';
import { Alert, Button, Chip, LinearProgress, Stack, Typography } from '@mui/joy';
import type { UserComplianceResponse } from '@bike4mind/common';
import { AdminDialog } from '@client/app/components/admin/shared/AdminDialog';
import { DATETIME_COLUMN_WIDTH, DataTable, type DataColumn } from '@client/app/components/admin/shared/DataTable';
import { Dash } from '@client/app/components/admin/shared/Dash';
import { EmptyState } from '@client/app/components/admin/shared/EmptyState';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { getErrorMessage } from '@client/app/utils/error';
import { useGetUserCompliance } from '@client/app/hooks/data/userCompliance';

export const useComplianceModal = create<{
  userId: string | null;
  setUserId: (userId: string | null) => void;
}>()(set => ({
  userId: null,
  setUserId: userId => set({ userId }),
}));

const fmt = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString() : '—');

type Incident = UserComplianceResponse['moderationIncidents'][number] & { rowId: string };
type AuthEvent = UserComplianceResponse['recentAuthEvents'][number] & { rowId: string };

const TABLE_MAX_HEIGHT = '40vh';
// Fits the longest UserAuthAuditEvent (`account_data_export_requested`) at ~7.5 px a character, plus cell padding.
const EVENT_COLUMN_WIDTH = '16rem';
// When (13.5rem) + Event + 7.5rem for each of the three wrap columns; below this the table scrolls sideways.
const AUTH_EVENTS_MIN_WIDTH = '52rem';

const Mono = ({ children }: { children: string }) => (
  <Typography level="body-sm" sx={{ fontFamily: 'code', color: 'inherit' }}>
    {children}
  </Typography>
);

const INCIDENT_COLUMNS: DataColumn<Incident>[] = [
  { id: 'when', label: 'When', width: DATETIME_COLUMN_WIDTH, render: m => fmt(m.createdAt) },
  {
    id: 'labels',
    label: 'Labels',
    wrap: true,
    render: m => m.labels.map(l => `${l.name} (${Math.round(l.confidence * 100)}%)`).join(', '),
  },
  { id: 'provider', label: 'Provider', render: m => m.provider },
  { id: 'model', label: 'Model', render: m => m.model },
];

const AUTH_EVENT_COLUMNS: DataColumn<AuthEvent>[] = [
  { id: 'when', label: 'When', width: DATETIME_COLUMN_WIDTH, render: e => fmt(e.createdAt) },
  { id: 'event', label: 'Event', width: EVENT_COLUMN_WIDTH, render: e => e.event },
  // actorUserId is only set for admin-driven events (e.g. session_revoked) - a self-initiated
  // logout has no distinct actor to show.
  {
    id: 'actor',
    label: 'Actor',
    wrap: true,
    render: e => (e.actorUserId ? <Mono>{e.actorUserId}</Mono> : <Dash title="No actor" />),
  },
  { id: 'ip', label: 'IP', wrap: true, render: e => <Mono>{e.actorIp}</Mono> },
  { id: 'userAgent', label: 'User agent', wrap: true, render: e => e.userAgent },
];

const withRowIds = <T,>(rows: readonly T[] | undefined) => (rows ?? []).map((row, i) => ({ ...row, rowId: String(i) }));
const getRowId = (row: { rowId: string }) => row.rowId;

const ComplianceModal = () => {
  const [userId, setUserId] = useComplianceModal(useShallow(s => [s.userId, s.setUserId]));
  const { data, isLoading, isError, error, refetch } = useGetUserCompliance(userId);
  const incidents = useMemo(() => withRowIds(data?.moderationIncidents), [data?.moderationIncidents]);
  const authEvents = useMemo(() => withRowIds(data?.recentAuthEvents), [data?.recentAuthEvents]);

  return (
    <AdminDialog
      open={!!userId}
      onClose={() => setUserId(null)}
      title="User compliance"
      width={720}
      data-testid="compliance-modal"
    >
      {isError ? (
        <Alert color="danger" variant="soft" data-testid="compliance-error">
          <Stack spacing={1}>
            <Typography level="body-sm">Failed to load compliance data: {getErrorMessage(error)}</Typography>
            <Button size="sm" variant="outlined" color="danger" onClick={() => refetch()}>
              Retry
            </Button>
          </Stack>
        </Alert>
      ) : isLoading || !data ? (
        <LinearProgress />
      ) : (
        <Stack spacing={3} mt={1}>
          {/* 1. Legal acceptance (AUP/ToS gate) */}
          <Stack spacing={1} data-testid="compliance-legal-section">
            <Typography level="title-md">Legal acceptance</Typography>
            {data.aupAcceptedVersion ? (
              <>
                <Typography level="body-sm">
                  AUP accepted: version <b>{data.aupAcceptedVersion}</b> on {fmt(data.aupAcceptedAt)} · Status:{' '}
                  <Chip size="sm" color={data.isCurrent ? 'success' : 'warning'}>
                    {data.isCurrent ? 'Current' : 'Not current'}
                  </Chip>
                </Typography>
                <Typography level="body-xs">
                  In-force version: {data.currentPolicyVersion} · Adult attested:{' '}
                  {data.ageAttestedAdult === null ? '\u2014' : data.ageAttestedAdult ? 'Yes' : 'No'}
                </Typography>
              </>
            ) : (
              <Typography level="body-sm" data-testid="compliance-never-accepted" color="danger">
                Never accepted the AUP (in-force version: {data.currentPolicyVersion}).
              </Typography>
            )}
          </Stack>

          {/* 2. Moderation incidents */}
          <Stack spacing={1}>
            <Typography level="title-md">Moderation incidents ({data.moderationIncidents.length})</Typography>
            <DataTable
              testId="compliance-incidents-table"
              label="Moderation incidents"
              rows={incidents}
              columns={INCIDENT_COLUMNS}
              getRowId={getRowId}
              // The API caps both lists (ROW_LIMIT in pages/api/admin/users/[userId]/compliance.ts), so neither pages.
              pagination={false}
              maxHeight={TABLE_MAX_HEIGHT}
              onRetry={() => void refetch()}
              empty={<EmptyState title="No incidents" action={null} />}
            />
          </Stack>

          {/* 3. Flags */}
          <Stack spacing={1} data-testid="compliance-flags">
            <Typography level="title-md">Moderation / ban state</Typography>
            <Stack direction="row" spacing={1}>
              <Chip color={data.flags.isBanned ? 'danger' : 'neutral'}>Banned: {String(data.flags.isBanned)}</Chip>
              <Chip color={data.flags.isModerated ? 'warning' : 'neutral'}>
                Moderated: {String(data.flags.isModerated)}
              </Chip>
              <Chip color={data.flags.disputePending ? 'warning' : 'neutral'}>
                Dispute pending: {String(data.flags.disputePending)}
              </Chip>
            </Stack>
          </Stack>

          {/* 4. Auth trail */}
          <Stack spacing={1}>
            <Typography level="title-md">Recent auth events ({data.recentAuthEvents.length})</Typography>
            <DataTable
              testId="compliance-auth-events"
              label="Recent auth events"
              rows={authEvents}
              columns={AUTH_EVENT_COLUMNS}
              getRowId={getRowId}
              minWidth={AUTH_EVENTS_MIN_WIDTH}
              pagination={false}
              maxHeight={TABLE_MAX_HEIGHT}
              onRetry={() => void refetch()}
              empty={<EmptyState title="No recent events" action={null} />}
            />
          </Stack>
        </Stack>
      )}
    </AdminDialog>
  );
};

export default ComplianceModal;
