import { useState } from 'react';
import {
  Box,
  Button,
  Table,
  Sheet,
  Typography,
  IconButton,
  Chip,
  Stack,
  LinearProgress,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import StopIcon from '@mui/icons-material/Stop';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FilterListIcon from '@mui/icons-material/FilterList';
import { useEmailJobs, useCancelEmailJob, useCloneEmailJob } from '@client/app/hooks/data/emailMarketing';
import { EmailJobStatus, EmailJobOverallStatus, IEmailJobDocument } from '@bike4mind/common';
import { EmptyState, ErrorState, LoadingState } from '../shared';
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

  const {
    data: jobs,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useEmailJobs({
    excludeTest,
    startDate: dateRange.start || undefined,
    endDate: dateRange.end || undefined,
  });
  const cancelMutation = useCancelEmailJob();
  const cloneMutation = useCloneEmailJob();

  const hasFilters = excludeTest || Boolean(dateRange.start) || Boolean(dateRange.end);

  const handleOpenCreate = () => {
    setIsCreating(true);
    setSelectedJobId(null);
  };

  const clearFilters = () => {
    setExcludeTest(false);
    setDateRange({ start: '', end: '' });
  };

  const handleOpenEdit = (job: IEmailJobDocument) => {
    setSelectedJobId(job.id);
    setIsCreating(false);
  };

  const handleBackToList = () => {
    setSelectedJobId(null);
    setIsCreating(false);
  };

  const handleCancel = async (id: string) => {
    await cancelMutation.mutateAsync(id);
  };

  const handleClone = async (id: string) => {
    await cloneMutation.mutateAsync(id);
  };

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

      {/* Filter Controls */}
      {showFilters && (
        <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md' }}>
          <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap">
            <Checkbox
              label="Exclude test campaigns"
              checked={excludeTest}
              onChange={e => setExcludeTest(e.target.checked)}
              data-testid="exclude-test-checkbox"
            />
            <FormControl size="sm" sx={{ minWidth: 150 }}>
              <FormLabel>From Date</FormLabel>
              <Input
                type="date"
                value={dateRange.start}
                onChange={e => setDateRange({ ...dateRange, start: e.target.value })}
                data-testid="date-range-start-input"
              />
            </FormControl>
            <FormControl size="sm" sx={{ minWidth: 150 }}>
              <FormLabel>To Date</FormLabel>
              <Input
                type="date"
                value={dateRange.end}
                onChange={e => setDateRange({ ...dateRange, end: e.target.value })}
                data-testid="date-range-end-input"
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
        <ErrorState message="Could not load campaigns." onRetry={() => void refetch()} retrying={isFetching} />
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table stickyHeader>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>Name</th>
                <th style={{ width: '12%' }}>Recipients</th>
                <th style={{ width: '10%' }}>Status</th>
                <th style={{ width: '22%' }}>Progress</th>
                <th style={{ width: '12%' }}>Open Rate</th>
                <th style={{ width: '22%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs?.data?.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    {hasFilters ? (
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
                    )}
                  </td>
                </tr>
              )}
              {jobs?.data?.map((job: IEmailJobDocument) => (
                <tr key={job.id}>
                  <td>
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
                  </td>
                  <td>
                    <Chip size="sm" variant="soft" color="neutral">
                      {job.isTestMode
                        ? `${job.testEmailAddresses?.length || 0} Test`
                        : getRecipientTypeLabel(job.recipientFilter)}
                    </Chip>
                  </td>
                  <td>
                    <Stack spacing={0.5}>
                      {/* Only show overallStatus if not DRAFT */}
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
                    </Stack>
                  </td>
                  <td>
                    {job.recipientCount > 0 ? (
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
                    )}
                  </td>
                  <td>
                    {job.sentCount > 0 ? (
                      <Typography level="body-sm">{((job.openedCount / job.sentCount) * 100).toFixed(1)}%</Typography>
                    ) : (
                      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                        -
                      </Typography>
                    )}
                  </td>
                  <td>
                    <Stack direction="row" spacing={1}>
                      {/* Edit/View button - always show, navigates to detail page */}
                      <IconButton
                        size="sm"
                        variant="plain"
                        onClick={() => handleOpenEdit(job)}
                        data-testid={`edit-job-${job.id}`}
                        title="View/Edit campaign"
                      >
                        <EditIcon />
                      </IconButton>

                      {/* Cancel - when scheduled or actively sending */}
                      {job.status === EmailJobStatus.SCHEDULED && (
                        <Button
                          size="sm"
                          variant="soft"
                          color="danger"
                          startDecorator={<StopIcon />}
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
                          onClick={() => handleCancel(job.id)}
                          loading={cancelMutation.isPending}
                          data-testid={`cancel-job-${job.id}`}
                        >
                          Cancel
                        </Button>
                      )}

                      {/* Clone button - always available */}
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="primary"
                        onClick={() => handleClone(job.id)}
                        loading={cloneMutation.isPending}
                        title="Clone campaign"
                        data-testid={`clone-job-${job.id}`}
                      >
                        <ContentCopyIcon />
                      </IconButton>
                    </Stack>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}
    </Stack>
  );
}
