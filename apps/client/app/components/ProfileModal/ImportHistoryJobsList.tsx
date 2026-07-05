import { FC, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Chip,
  IconButton,
  LinearProgress,
  Sheet,
  Stack,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import { RefreshRounded, ErrorOutline, CheckCircle, Schedule, HourglassEmpty, Cancel } from '@mui/icons-material';
import {
  useListImportHistoryJobs,
  useRetryImportHistoryJob,
  useImportHistoryJobWebSocket,
} from '@client/app/hooks/data/importHistoryJobs';
import { IImportHistoryJob } from '@bike4mind/database/content';

const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
};

interface ImportHistoryJobsListProps {
  onClose?: () => void;
}

const ImportHistoryJobRow: FC<{ job: IImportHistoryJob }> = ({ job }) => {
  const { mutate: retryImport, isPending: isRetrying } = useRetryImportHistoryJob();
  const liveProgress = useImportHistoryJobWebSocket(job.id);

  // Use live progress if available, otherwise use job data
  const status = liveProgress?.status || job.status;
  const progress = liveProgress?.progress || job.progress;
  const currentStep = liveProgress?.currentStep || job.currentStep;
  const processedItems = liveProgress?.processedItems || job.processedItems;
  const totalItems = liveProgress?.totalItems || job.totalItems;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'success';
      case 'failed':
        return 'danger';
      case 'processing':
        return 'primary';
      case 'pending':
        return 'neutral';
      case 'cancelled':
        return 'warning';
      default:
        return 'neutral';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle />;
      case 'failed':
        return <ErrorOutline />;
      case 'processing':
        return <HourglassEmpty />;
      case 'pending':
        return <Schedule />;
      case 'cancelled':
        return <Cancel />;
      default:
        return null;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  return (
    <tr>
      <td>
        <Stack spacing={0.5}>
          <Typography level="body-sm" fontWeight="md">
            {job.source}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {formatRelativeTime(new Date(job.createdAt))}
          </Typography>
        </Stack>
      </td>
      <td>
        <Chip size="sm" variant="soft" color={getStatusColor(status) as any} startDecorator={getStatusIcon(status)}>
          {status}
        </Chip>
      </td>
      <td>
        <Stack spacing={0.5} sx={{ minWidth: 200 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography level="body-xs">{currentStep}</Typography>
            <Typography level="body-xs" fontWeight="md">
              {progress}%
            </Typography>
          </Box>
          <LinearProgress determinate value={progress} size="sm" color={getStatusColor(status) as any} />
          {totalItems > 0 && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {processedItems}/{totalItems} items
            </Typography>
          )}
        </Stack>
      </td>
      <td>
        <Typography level="body-sm">{formatFileSize(job.fileSize)}</Typography>
      </td>
      <td>
        {status === 'failed' && (
          <Tooltip title="Retry import">
            <IconButton
              size="sm"
              variant="outlined"
              color="primary"
              onClick={() => retryImport(job.id)}
              disabled={isRetrying}
              data-testid={`retry-import-${job.id}`}
            >
              <RefreshRounded />
            </IconButton>
          </Tooltip>
        )}
      </td>
    </tr>
  );
};

const ImportHistoryJobsList: FC<ImportHistoryJobsListProps> = ({ onClose }) => {
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();

  const { data, isLoading, refetch } = useListImportHistoryJobs({
    status: statusFilter as any,
    source: sourceFilter as any,
    page: 1,
    limit: 20,
  });

  return (
    <Sheet
      sx={{
        width: '100%',
        maxWidth: 1200,
        mx: 'auto',
        p: 3,
        borderRadius: 'md',
      }}
      data-testid="import-history-jobs-list"
    >
      <Stack spacing={3}>
        {/* Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography level="h3">Import History</Typography>
          <Button
            size="sm"
            variant="outlined"
            startDecorator={<RefreshRounded />}
            onClick={() => refetch()}
            data-testid="refresh-imports-btn"
          >
            Refresh
          </Button>
        </Box>

        {/* Filters */}
        <Stack direction="row" spacing={2}>
          <Button
            size="sm"
            variant={!statusFilter ? 'solid' : 'outlined'}
            onClick={() => setStatusFilter(undefined)}
            data-testid="filter-all-status"
          >
            All
          </Button>
          <Button
            size="sm"
            variant={statusFilter === 'processing' ? 'solid' : 'outlined'}
            onClick={() => setStatusFilter('processing')}
            data-testid="filter-processing-status"
          >
            Processing
          </Button>
          <Button
            size="sm"
            variant={statusFilter === 'completed' ? 'solid' : 'outlined'}
            color="success"
            onClick={() => setStatusFilter('completed')}
            data-testid="filter-completed-status"
          >
            Completed
          </Button>
          <Button
            size="sm"
            variant={statusFilter === 'failed' ? 'solid' : 'outlined'}
            color="danger"
            onClick={() => setStatusFilter('failed')}
            data-testid="filter-failed-status"
          >
            Failed
          </Button>
        </Stack>

        <Stack direction="row" spacing={2}>
          <Button
            size="sm"
            variant={!sourceFilter ? 'solid' : 'outlined'}
            onClick={() => setSourceFilter(undefined)}
            data-testid="filter-all-source"
          >
            All Sources
          </Button>
          <Button
            size="sm"
            variant={sourceFilter === 'OpenAI' ? 'solid' : 'outlined'}
            onClick={() => setSourceFilter('OpenAI')}
            data-testid="filter-openai-source"
          >
            OpenAI
          </Button>
          <Button
            size="sm"
            variant={sourceFilter === 'Claude' ? 'solid' : 'outlined'}
            onClick={() => setSourceFilter('Claude')}
            data-testid="filter-claude-source"
          >
            Claude
          </Button>
          <Button
            size="sm"
            variant={sourceFilter === 'Notebook' ? 'solid' : 'outlined'}
            onClick={() => setSourceFilter('Notebook')}
            data-testid="filter-notebook-source"
          >
            Notebook
          </Button>
        </Stack>

        {/* Table */}
        {isLoading ? (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography level="body-sm">Loading import history...</Typography>
          </Box>
        ) : !data || data.data.length === 0 ? (
          <Card variant="soft" sx={{ p: 3, textAlign: 'center' }}>
            <Typography level="body-md">No imports found</Typography>
            <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 1 }}>
              Your import history will appear here
            </Typography>
          </Card>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
            <Table stickyHeader>
              <thead>
                <tr>
                  <th style={{ width: '15%' }}>Source</th>
                  <th style={{ width: '15%' }}>Status</th>
                  <th style={{ width: '40%' }}>Progress</th>
                  <th style={{ width: '15%' }}>File Size</th>
                  <th style={{ width: '15%' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map(job => (
                  <ImportHistoryJobRow key={job.id} job={job} />
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}

        {/* Stats */}
        {data && data.total > 0 && (
          <Box sx={{ textAlign: 'center' }}>
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              Showing {data.data.length} of {data.total} imports
              {data.hasMore && ' (scroll down for more)'}
            </Typography>
          </Box>
        )}
      </Stack>
    </Sheet>
  );
};

export default ImportHistoryJobsList;
