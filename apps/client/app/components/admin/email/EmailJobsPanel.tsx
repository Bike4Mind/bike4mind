import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Sheet,
  Typography,
  IconButton,
  Chip,
  Stack,
  LinearProgress,
  Checkbox,
  FormControl,
  FormLabel,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FilterListIcon from '@mui/icons-material/FilterList';
import { OptionalDateInput } from '@client/app/components/common/OptionalDateInput';
import { todayUtc } from '@client/app/utils/dateUtils';
import { getErrorMessage } from '@client/app/utils/error';
import { useEmailJobs, useCancelEmailJob, useCloneEmailJob } from '@client/app/hooks/data/emailMarketing';
import { EmailJobStatus, EmailJobOverallStatus, IEmailJobDocument } from '@bike4mind/common';
import { DataTable, type DataColumn, EmptyState, ErrorState, LoadingState } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import EmailJobDetail from './EmailJobDetail';

export default function EmailJobsPanel() {
  // View state: 'list' or job ID for detail view
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Filter state
  const [excludeTest, setExcludeTest] = useState(false);
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: jobs,
    isLoading,
    isError,
    isPlaceholderData,
    refetch,
  } = useEmailJobs({
    page,
    limit,
    excludeTest,
    startDate: dateRange.start || undefined,
    endDate: dateRange.end || undefined,
  });
  const cancelMutation = useCancelEmailJob();
  const cloneMutation = useCloneEmailJob();

  const hasFilters = excludeTest || Boolean(dateRange.start) || Boolean(dateRange.end);

  const handleOpenCreate = () => {
    setActionError(null);
    setIsCreating(true);
    setSelectedJobId(null);
  };

  const clearFilters = () => {
    setExcludeTest(false);
    setDateRange({ start: '', end: '' });
    setPage(1);
  };

  const handleOpenEdit = (job: IEmailJobDocument) => {
    setActionError(null);
    setSelectedJobId(job.id);
    setIsCreating(false);
  };

  const handleBackToList = () => {
    setSelectedJobId(null);
    setIsCreating(false);
  };

  const runRowAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(getErrorMessage(error));
    }
  };

  const handleCancel = (id: string) => runRowAction(() => cancelMutation.mutateAsync(id));

  const handleClone = (id: string) => runRowAction(() => cloneMutation.mutateAsync(id));

  const getProgress = (job: IEmailJobDocument) => {
    if (job.recipientCount === 0) return 0;
    return ((job.sentCount + job.failedCount) / job.recipientCount) * 100;
  };

  const getRecipientTypeLabel = (filter: any): string => {
    if (filter?.specificEmails?.length) return `${filter.specificEmails.length} Specific`;
    if (filter?.allUsers && filter?.allSubscribers) return 'All users and waitlist';
    if (filter?.allUsers) return 'Users';
    if (filter?.allSubscribers || filter?.all) return 'Waitlist';
    return 'Custom';
  };

  const columns: DataColumn<IEmailJobDocument>[] = [
    {
      id: 'name',
      label: 'Name',
      width: '22%',
      wrap: true,
      render: job => (
        <>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography level="body-sm" fontWeight="md">
              {job.name}
            </Typography>
            {job.isTestMode && (
              <Chip size="sm" variant="soft" color="warning">
                TEST
              </Chip>
            )}
          </Stack>
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            {new Date(job.createdAt).toLocaleDateString()}
          </Typography>
        </>
      ),
    },
    {
      id: 'recipients',
      label: 'Recipients',
      width: '12%',
      render: job => (
        <Chip size="sm" variant="soft" color="neutral">
          {job.isTestMode ? `${job.testEmailAddresses?.length || 0} Test` : getRecipientTypeLabel(job.recipientFilter)}
        </Chip>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      width: '11rem',
      wrap: true,
      render: job => (
        <Stack spacing={0.5}>
          {job.overallStatus && job.overallStatus !== EmailJobOverallStatus.DRAFT && (
            <Chip
              size="sm"
              variant="soft"
              color={
                job.overallStatus === EmailJobOverallStatus.SENDING
                  ? 'warning'
                  : job.overallStatus === EmailJobOverallStatus.COMPLETE
                    ? 'success'
                    : job.overallStatus === EmailJobOverallStatus.PARTIAL
                      ? 'primary'
                      : 'danger'
              }
            >
              {job.overallStatus}
            </Chip>
          )}
          {job.lastSentAt && (
            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
              Last sent: {new Date(job.lastSentAt).toLocaleDateString()}
            </Typography>
          )}
          {job.status === EmailJobStatus.SCHEDULED && job.scheduledAt && (
            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
              Scheduled: {new Date(job.scheduledAt).toLocaleString()}
            </Typography>
          )}
          {job.status === EmailJobStatus.SCHEDULED && (
            <Button
              size="sm"
              variant="soft"
              color="danger"
              startDecorator={<StopIcon />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => handleCancel(job.id)}
              loading={cancelMutation.isPending}
              data-testid={`cancel-scheduled-job-${job.id}`}
            >
              Cancel
            </Button>
          )}
          {(job.status === EmailJobStatus.QUEUED ||
            job.status === EmailJobStatus.PROCESSING ||
            job.overallStatus === EmailJobOverallStatus.SENDING) && (
            <Button
              size="sm"
              variant="soft"
              color="danger"
              startDecorator={<StopIcon />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => handleCancel(job.id)}
              loading={cancelMutation.isPending}
              data-testid={`cancel-job-${job.id}`}
            >
              Cancel
            </Button>
          )}
        </Stack>
      ),
    },
    {
      id: 'progress',
      label: 'Progress',
      wrap: true,
      render: job =>
        job.recipientCount > 0 ? (
          <Box>
            <LinearProgress determinate value={getProgress(job)} sx={{ mb: 0.5 }} />
            <Typography level="body-xs">
              {job.sentCount + job.failedCount} / {job.recipientCount}
              {job.failedCount > 0 && (
                <Typography component="span" color="danger">
                  {' '}
                  ({job.failedCount} failed)
                </Typography>
              )}
            </Typography>
          </Box>
        ) : (
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            Not started
          </Typography>
        ),
    },
    {
      id: 'openRate',
      label: 'Open rate',
      width: '7rem',
      numeric: true,
      render: job =>
        job.sentCount > 0 ? (
          <Typography level="body-sm">{((job.openedCount / job.sentCount) * 100).toFixed(1)}%</Typography>
        ) : (
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            -
          </Typography>
        ),
    },
  ];

  const renderRowActions = (job: IEmailJobDocument) => (
    <>
      <IconButton
        size="sm"
        variant="plain"
        onClick={() => handleOpenEdit(job)}
        aria-label="View or edit campaign"
        data-testid={`edit-job-${job.id}`}
        title="View/Edit campaign"
      >
        <EditIcon />
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color="primary"
        onClick={() => handleClone(job.id)}
        loading={cloneMutation.isPending}
        title="Clone campaign"
        aria-label="Clone campaign"
        data-testid={`clone-job-${job.id}`}
      >
        <ContentCopyIcon />
      </IconButton>
    </>
  );

  // Show detail view when editing or creating
  if (selectedJobId || isCreating) {
    return <EmailJobDetail jobId={selectedJobId || undefined} onBack={handleBackToList} />;
  }

  // Show list view - simple layout, scrolls with page
  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="email-campaigns-panel">
      <Stack direction="row" justifyContent="flex-end" flexWrap="wrap" gap={1}>
        <Button
          size="sm"
          variant={showFilters ? 'soft' : 'plain'}
          color="neutral"
          startDecorator={<FilterListIcon />}
          onClick={() => setShowFilters(!showFilters)}
          data-testid="filter-campaigns-btn"
        >
          Filters
        </Button>
        <Button size="sm" startDecorator={<AddIcon />} onClick={handleOpenCreate} data-testid="new-campaign-btn">
          New campaign
        </Button>
      </Stack>

      {actionError && (
        <Alert color="danger" variant="soft" data-testid="email-campaigns-action-error">
          {actionError}
        </Alert>
      )}

      {/* Filter Controls */}
      {showFilters && (
        <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md' }}>
          <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap">
            <Checkbox
              label="Exclude test campaigns"
              checked={excludeTest}
              onChange={e => {
                setExcludeTest(e.target.checked);
                setPage(1);
              }}
              data-testid="exclude-test-checkbox"
            />
            <FormControl size="sm" sx={{ minWidth: 150 }}>
              <FormLabel>From Date</FormLabel>
              <OptionalDateInput
                size="sm"
                value={dateRange.start}
                onChange={start => {
                  setDateRange({ ...dateRange, start });
                  setPage(1);
                }}
                emptyLabel="From any date"
                setLabel="Set start date"
                clearLabel="Remove start date"
                initialDate={() => (dateRange.end && dateRange.end < todayUtc() ? dateRange.end : todayUtc())}
                max={dateRange.end || undefined}
                aria-label="From date"
                testId="date-range-start-input"
              />
            </FormControl>
            <FormControl size="sm" sx={{ minWidth: 150 }}>
              <FormLabel>To Date</FormLabel>
              <OptionalDateInput
                size="sm"
                value={dateRange.end}
                onChange={end => {
                  setDateRange({ ...dateRange, end });
                  setPage(1);
                }}
                emptyLabel="To any date"
                setLabel="Set end date"
                clearLabel="Remove end date"
                initialDate={() => (dateRange.start && dateRange.start > todayUtc() ? dateRange.start : todayUtc())}
                min={dateRange.start || undefined}
                aria-label="To date"
                testId="date-range-end-input"
              />
            </FormControl>
            {hasFilters && (
              <Button size="sm" variant="plain" color="neutral" onClick={clearFilters} data-testid="clear-filters-btn">
                Clear filters
              </Button>
            )}
          </Stack>
        </Sheet>
      )}

      {isLoading ? (
        <LoadingState label="Loading campaigns" testId="email-campaigns-loading" />
      ) : isError && !jobs ? (
        <ErrorState message="Could not load campaigns." onRetry={() => void refetch()} />
      ) : (
        <DataTable<IEmailJobDocument>
          label="Email campaigns"
          testId="email-campaigns-table"
          rows={jobs?.data ?? []}
          columns={columns}
          getRowId={job => job.id}
          loading={isPlaceholderData}
          onRetry={() => void refetch()}
          empty={
            hasFilters ? (
              <EmptyState
                title="No campaigns match these filters"
                action={
                  <Button
                    size="sm"
                    variant="outlined"
                    onClick={clearFilters}
                    data-testid="email-campaigns-empty-clear-filters-btn"
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No campaigns yet"
                description="A campaign sends a template to the recipients you pick, now or on a schedule."
                action={
                  <Button
                    size="sm"
                    variant="outlined"
                    startDecorator={<AddIcon />}
                    onClick={handleOpenCreate}
                    data-testid="email-campaigns-empty-create-btn"
                  >
                    New campaign
                  </Button>
                }
              />
            )
          }
          pagination={{
            page,
            pageSize: limit,
            total: jobs?.meta.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: size => {
              setLimit(size);
              setPage(1);
            },
          }}
          rowActions={renderRowActions}
          actionsWidth="6rem"
          minWidth="52rem"
        />
      )}
    </Stack>
  );
}
