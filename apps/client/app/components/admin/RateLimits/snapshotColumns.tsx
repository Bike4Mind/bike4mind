import React from 'react';
import { Typography } from '@mui/joy';
import { DATETIME_COLUMN_WIDTH, type DataColumn } from '../shared';
import type { RateLimitSnapshot } from './types';

type SnapshotColumn = DataColumn<RateLimitSnapshot>;

const timestamp: SnapshotColumn = {
  id: 'timestamp',
  label: 'Timestamp',
  width: DATETIME_COLUMN_WIDTH,
  render: snap => new Date(snap.timestamp).toLocaleString(),
};
const integration: SnapshotColumn = {
  id: 'integration',
  label: 'Integration',
  width: '8rem',
  render: snap => <span style={{ textTransform: 'capitalize' }}>{snap.integration}</span>,
};
const endpoint: SnapshotColumn = {
  id: 'endpoint',
  label: 'Endpoint',
  width: '14rem',
  render: snap => (
    <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
      {snap.endpoint}
    </Typography>
  ),
};
const retryAfter: SnapshotColumn = {
  id: 'retryAfter',
  label: 'Retry after',
  width: '7rem',
  numeric: true,
  render: snap => (snap.retryAfterMs ? `${snap.retryAfterMs}ms` : '--'),
};

export const snapshotColumns: SnapshotColumn[] = [
  timestamp,
  integration,
  endpoint,
  { id: 'limit', label: 'Limit', width: '5rem', numeric: true, render: snap => snap.limit ?? '--' },
  { id: 'remaining', label: 'Remaining', width: '6rem', numeric: true, render: snap => snap.remaining ?? '--' },
  {
    id: 'usagePercent',
    label: 'Usage %',
    width: '6rem',
    numeric: true,
    render: snap => (snap.usagePercent !== null ? `${snap.usagePercent}%` : '--'),
  },
  { id: 'throttled', label: 'Throttled', width: '6rem', render: snap => (snap.wasThrottled ? 'Yes' : 'No') },
  retryAfter,
];

export const throttledColumns: SnapshotColumn[] = [timestamp, integration, endpoint, retryAfter];
