import React, { useState } from 'react';
import { Alert, Button, Typography, Stack } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MODERATION_INCIDENT_ID_PARAM } from '@bike4mind/common';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  SegmentedControl,
  StatusChip,
  formatUtc,
  relativeTime,
  type DataColumn,
} from './shared';
import ModerationIncidentDetail from './ModerationIncidentDetail';
import { REVIEW_STATUS_LABELS, formatLabel, surfaceLabel } from './moderationIncidentLabels';
import {
  useModerationIncidentQueue,
  type ClosedCursor,
  type ModerationIncidentQueueStatus,
  type ModerationIncidentRow,
} from '@client/app/hooks/data/moderationIncidents';

const QUEUE_STATUS_OPTIONS = [
  { value: 'open', label: 'Needs review' },
  { value: 'closed', label: 'Closed' },
] as const;

/**
 * Image moderation incidents waiting for a reviewer: unreviewed ones plus claims stuck mid-report,
 * oldest first; or, under Closed, past verdicts newest first. A row opens its detail, which is
 * addressed by `incidentId` so the reviewer alert can link straight to it.
 */
export const ModerationIncidentsTab: React.FC = () => {
  const [queueStatus, setQueueStatus] = useState<ModerationIncidentQueueStatus>('open');
  // Closed verdicts never drain, so the Closed list pages back by createdAt instead.
  const [closedCursor, setClosedCursor] = useState<ClosedCursor | undefined>(undefined);
  const closedBefore = closedCursor?.before;
  const queue = useModerationIncidentQueue(queueStatus, closedCursor);
  const closed = queueStatus === 'closed';
  const changeQueueStatus = (status: ModerationIncidentQueueStatus) => {
    setQueueStatus(status);
    setClosedCursor(undefined);
  };
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
      id: 'user',
      label: 'User',
      render: row => (
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
          {row.userEmail ?? row.userId}
        </Typography>
      ),
      sortValue: row => row.userEmail ?? row.userId,
    },
    {
      id: 'label',
      label: 'Top label',
      render: row => (
        <Typography level="body-sm" noWrap>
          {row.topLabel ? formatLabel(row.topLabel) : '-'}
        </Typography>
      ),
      sortValue: row => row.topLabel?.confidence ?? 0,
    },
    {
      id: 'surface',
      label: closed ? 'Surface / verdict' : 'Surface',
      render: row => (
        <Stack direction="row" gap={1} alignItems="center">
          <Typography level="body-sm">{surfaceLabel(row.surface)}</Typography>
          {row.stuck && <StatusChip tone="warn" label="Report stuck" />}
          {closed && <StatusChip tone="neutral" label={REVIEW_STATUS_LABELS[row.reviewStatus]} />}
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

  const rows = queue.data?.rows ?? [];

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md' }}
      data-testid="admin-moderation-incidents-tab"
    >
      <AdminPageHeader
        title="Moderation review"
        count={queue.data && !queue.data.truncated && !closedBefore ? rows.length : undefined}
        description={
          closed
            ? 'Image moderation incidents with a verdict, newest first. Opening one records a view in the audit log.'
            : 'Image moderation incidents waiting for a verdict, oldest first. Opening one records a view in the audit log.'
        }
      />
      <SegmentedControl
        options={QUEUE_STATUS_OPTIONS}
        value={queueStatus}
        onChange={changeQueueStatus}
        aria-label="Which incidents to show"
        data-testid="moderation-incidents-status"
      />
      {!closed && queue.data?.truncated && (
        <Alert color="warning" data-testid="moderation-incidents-truncated">
          Showing the oldest {rows.length.toLocaleString()}; more are waiting. Decide these to see the rest.
        </Alert>
      )}
      {closed && (queue.data?.truncated || closedBefore) && (
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" data-testid="moderation-incidents-paging">
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted', mr: 'auto' }}>
            {closedBefore
              ? `Showing closed incidents from before ${formatUtc(new Date(closedBefore))}.`
              : `Showing the newest ${rows.length.toLocaleString()} closed incidents.`}
          </Typography>
          {closedBefore && (
            <Button
              size="sm"
              variant="plain"
              onClick={() => setClosedCursor(undefined)}
              data-testid="moderation-incidents-newest-btn"
            >
              Show newest
            </Button>
          )}
          {queue.data?.truncated && rows.length > 0 && (
            <Button
              size="sm"
              variant="outlined"
              onClick={() =>
                setClosedCursor({ before: rows[rows.length - 1].createdAt, beforeId: rows[rows.length - 1].id })
              }
              data-testid="moderation-incidents-older-btn"
            >
              Show older
            </Button>
          )}
        </Stack>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        label={closed ? 'Closed moderation incidents' : 'Moderation incidents waiting for review'}
        getRowId={row => row.id}
        testId="moderation-incidents-table"
        rowTestId={row => `moderation-incident-row-${row.id}`}
        loading={queue.isPending}
        error={queue.error ? "Couldn't load the review queue." : undefined}
        onRetry={() => void queue.refetch()}
        onRowActivate={row => void open(row.id)}
        minWidth="64rem"
        empty={
          <EmptyState
            title={closed ? 'No incidents have a verdict yet' : 'No incidents are waiting for review'}
            description={
              closed
                ? 'Incidents appear here once a reviewer records a verdict.'
                : 'New incidents land here, and reviewers are alerted by email when one needs a verdict.'
            }
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
