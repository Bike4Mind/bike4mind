import React, { useState } from 'react';
import { Button, Typography, Stack } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MODERATION_INCIDENT_ID_PARAM } from '@bike4mind/common';
import { AdminPageHeader, DataTable, EmptyState, StatusChip, formatUtc, relativeTime, type DataColumn } from './shared';
import ModerationIncidentDetail from './ModerationIncidentDetail';
import { surfaceLabel } from './moderationIncidentLabels';
import { useModerationIncidentQueue, type ModerationIncidentRow } from '@client/app/hooks/data/moderationIncidents';

/**
 * Image moderation incidents waiting for a reviewer: unreviewed ones plus claims stuck mid-report,
 * oldest first. A row opens its detail, which is addressed by `incidentId` so the reviewer alert
 * can link straight to it.
 */
export const ModerationIncidentsTab: React.FC = () => {
  const queue = useModerationIncidentQueue();
  const navigate = useNavigate();
  const { [MODERATION_INCIDENT_ID_PARAM]: incidentId } = useSearch({ strict: false }) as { incidentId?: string };
  const [now] = useState(() => Date.now());

  const open = (id: string | undefined) =>
    navigate({ to: '/admin', search: previous => ({ ...previous, [MODERATION_INCIDENT_ID_PARAM]: id }) });

  if (incidentId) return <ModerationIncidentDetail incidentId={incidentId} onBack={() => open(undefined)} />;

  const columns: readonly DataColumn<ModerationIncidentRow>[] = [
    {
      id: 'id',
      label: 'Incident',
      render: row => (
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink', fontFamily: 'code' }}>
          {row.id}
        </Typography>
      ),
      sortValue: row => row.id,
    },
    {
      id: 'createdAt',
      label: 'Time',
      render: row => (
        <Typography component="time" level="body-sm" dateTime={row.createdAt} noWrap>
          {formatUtc(new Date(row.createdAt))}
        </Typography>
      ),
      sortValue: row => row.createdAt,
      width: '14rem',
    },
    {
      id: 'surface',
      label: 'Surface',
      render: row => (
        <Stack direction="row" gap={1} alignItems="center">
          <Typography level="body-sm">{surfaceLabel(row.surface)}</Typography>
          {row.stuck && <StatusChip tone="warn" label="Report stuck" />}
        </Stack>
      ),
      sortValue: row => row.surface ?? '',
      width: '14rem',
    },
    {
      id: 'age',
      label: 'Age',
      render: row => relativeTime(new Date(row.createdAt), now),
      // Oldest first on the default order; the sort key is the time so the column sorts the same way.
      sortValue: row => row.createdAt,
      width: '9rem',
    },
  ];

  const rows = queue.data ?? [];

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md' }}
      data-testid="admin-moderation-incidents-tab"
    >
      <AdminPageHeader
        title="Moderation review"
        count={queue.data ? rows.length : undefined}
        description="Image moderation incidents waiting for a verdict, oldest first. Opening one records a view in the audit log."
      />
      <DataTable
        rows={rows}
        columns={columns}
        label="Moderation incidents waiting for review"
        getRowId={row => row.id}
        testId="moderation-incidents-table"
        rowTestId={row => `moderation-incident-row-${row.id}`}
        loading={queue.isPending}
        error={queue.error ? "Couldn't load the review queue." : undefined}
        onRetry={() => void queue.refetch()}
        onRowActivate={row => void open(row.id)}
        minWidth="48rem"
        empty={
          <EmptyState
            title="No incidents are waiting for review"
            description="New incidents land here, and reviewers are alerted by email when one needs a verdict."
            action={
              <Button
                variant="outlined"
                data-testid="moderation-incidents-refresh-btn"
                onClick={() => void queue.refetch()}
              >
                Refresh queue
              </Button>
            }
          />
        }
      />
    </Stack>
  );
};

export default ModerationIncidentsTab;
