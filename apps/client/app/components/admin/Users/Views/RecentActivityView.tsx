import { Box, Stack, Typography } from '@mui/joy';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import React, { useMemo, useState } from 'react';
import { useGetRecentActivities } from '@client/app/hooks/data/user';
import { DATETIME_COLUMN_WIDTH, DataTable, type DataColumn } from '@client/app/components/admin/shared/DataTable';
import { EmptyState } from '@client/app/components/admin/shared/EmptyState';
import { getErrorMessage } from '@client/app/utils/error';

interface RecentActivityViewProps {
  limit?: number;
}

interface IActivityLog {
  id: string;
  userId: string;
  clientIp: string;
  path: string;
  datetime: Date;
}

interface IActivityMetadata {
  clientIp?: string;
  path?: string;
}

const formatTime = (datetime: Date) => new Date(datetime).toLocaleString();

const Mono = ({ children }: { children: string }) => (
  <Typography level="body-sm" sx={{ fontFamily: 'code', color: 'inherit' }}>
    {children}
  </Typography>
);

const COLUMNS: DataColumn<IActivityLog>[] = [
  {
    id: 'userId',
    label: 'User ID',
    render: row => <Mono>{row.userId}</Mono>,
  },
  {
    id: 'clientIp',
    label: 'IP Address',
    width: '10rem',
    wrap: true,
    render: row => <Mono>{row.clientIp}</Mono>,
  },
  {
    id: 'path',
    label: 'Endpoint',
    render: row => <Mono>{row.path}</Mono>,
  },
  { id: 'datetime', label: 'Time', width: DATETIME_COLUMN_WIDTH, render: row => formatTime(row.datetime) },
];

const getRowId = (row: IActivityLog) => row.id;

const DETAIL_FIELDS: { label: string; value: (activity: IActivityLog) => string; mono?: boolean }[] = [
  { label: 'User ID', value: a => a.userId, mono: true },
  { label: 'IP', value: a => a.clientIp, mono: true },
  { label: 'Endpoint', value: a => a.path, mono: true },
  { label: 'Time', value: a => formatTime(a.datetime) },
];

const RecentActivityRow: React.FC<{ activity: IActivityLog; index: number }> = ({ activity, index }) => {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded(prev => !prev);

  return (
    <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
      <Box
        data-testid={`recent-activity-mobile-summary-${index}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 1, cursor: 'pointer' }}
      >
        <Stack direction="column" sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight={600} noWrap sx={{ fontFamily: 'code' }}>
            {activity.path}
          </Typography>
          <Typography level="body-xs" color="neutral" noWrap>
            {formatTime(activity.datetime)}
          </Typography>
        </Stack>
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: 'text.tertiary' }}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </Box>
      </Box>

      {expanded && (
        <Stack spacing={1} sx={{ px: 1, pb: 1 }}>
          {DETAIL_FIELDS.map(field => (
            <Stack key={field.label} direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 60 }}>
                {field.label}:
              </Typography>
              <Typography
                level="body-xs"
                sx={{ minWidth: 0, overflowWrap: 'anywhere', ...(field.mono && { fontFamily: 'code' }) }}
              >
                {field.value(activity)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
};

const RecentActivityView: React.FC<RecentActivityViewProps> = ({ limit = 10 }) => {
  const { data, isLoading, isError, error, refetch } = useGetRecentActivities({ coverage: 'all' });

  const activities = useMemo<IActivityLog[]>(
    () =>
      (data ?? []).slice(0, limit).map((activity, index) => {
        const metadata = activity.metadata as IActivityMetadata | undefined;
        return {
          id: String(index),
          userId: activity.userId,
          clientIp: metadata?.clientIp || 'Unknown',
          path: metadata?.path || 'Unknown',
          datetime: activity.datetime,
        };
      }),
    [data, limit]
  );

  const table = (
    <DataTable
      testId="recent-activity-table"
      label="Recent activity"
      rows={activities}
      columns={COLUMNS}
      getRowId={getRowId}
      minWidth="41.5rem"
      pagination={false}
      loading={isLoading}
      error={isError ? getErrorMessage(error) : undefined}
      onRetry={() => void refetch()}
      empty={<EmptyState title="No recent activities found" action={null} />}
    />
  );

  // DataTable owns the loading, error and empty states at every width; the stacked list only replaces it on xs.
  if (isLoading || isError || activities.length === 0) return <Box sx={{ width: '100%' }}>{table}</Box>;

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>{table}</Box>
      <Box sx={{ display: { xs: 'block', sm: 'none' } }} data-testid="recent-activity-mobile-list">
        {activities.map((activity, index) => (
          <RecentActivityRow key={activity.id} activity={activity} index={index} />
        ))}
      </Box>
    </Box>
  );
};

export default RecentActivityView;
