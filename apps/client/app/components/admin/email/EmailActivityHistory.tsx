import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Sheet,
  Chip,
  IconButton,
  FormControl,
  FormLabel,
  Input,
  Select,
  Option,
  Checkbox,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { OptionalDateInput } from '@client/app/components/common/OptionalDateInput';
import { todayUtc } from '@client/app/utils/dateUtils';
import { useEmailJobHistory } from '@client/app/hooks/data/emailMarketing';
import { EmailSendStatus, IEmailSendAttemptDocument } from '@bike4mind/common';
import { DATETIME_COLUMN_WIDTH, DataTable, type DataColumn, EmptyState } from '../shared';

interface EmailActivityHistoryProps {
  jobId: string;
  onViewAttempt?: (attemptId: string) => void;
}

const getStatusColor = (status: EmailSendStatus) => {
  switch (status) {
    case EmailSendStatus.SENT:
    case EmailSendStatus.DELIVERED:
    case EmailSendStatus.OPENED:
    case EmailSendStatus.CLICKED:
      return 'success';
    case EmailSendStatus.PENDING:
      return 'warning';
    case EmailSendStatus.PROCESSING:
    case EmailSendStatus.QUEUED:
      return 'primary';
    case EmailSendStatus.FAILED:
    case EmailSendStatus.BOUNCED:
      return 'danger';
    case EmailSendStatus.CANCELLED:
      return 'neutral';
    default:
      return 'neutral';
  }
};

function EventTime({ at, color }: { at?: Date | string | null; color: 'success' | 'primary' }) {
  if (!at) {
    return (
      <Typography level="body-xs" color="neutral">
        -
      </Typography>
    );
  }
  return (
    <Typography level="body-xs" color={color}>
      {new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </Typography>
  );
}

export default function EmailActivityHistory({ jobId, onViewAttempt }: EmailActivityHistoryProps) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [excludeTest, setExcludeTest] = useState(true); // Exclude test emails by default
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 500);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data: historyData,
    isLoading,
    isError,
    isPlaceholderData,
    refetch,
  } = useEmailJobHistory(jobId, {
    page,
    limit,
    search: debouncedSearch,
    status: statusFilter === 'all' ? undefined : statusFilter,
    excludeTest,
    startDate,
    endDate,
  });

  const attempts = historyData?.data || [];
  const total = historyData?.meta?.total ?? 0;

  const columns: DataColumn<IEmailSendAttemptDocument>[] = [
    {
      id: 'time',
      label: 'Time',
      width: DATETIME_COLUMN_WIDTH,
      render: attempt => <Typography level="body-xs">{new Date(attempt.createdAt).toLocaleString()}</Typography>,
    },
    {
      id: 'status',
      label: 'Status',
      width: '9rem',
      wrap: true,
      render: attempt => (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip color={getStatusColor(attempt.status)} size="sm">
            {attempt.status.toUpperCase()}
          </Chip>
          {attempt.isTestEmail && (
            <Chip color="warning" size="sm">
              TEST
            </Chip>
          )}
        </Box>
      ),
    },
    {
      id: 'recipient',
      label: 'Recipient',
      wrap: true,
      render: attempt => (
        <>
          <Typography level="body-xs" sx={{ fontWeight: attempt.isTestEmail ? 'bold' : 'normal' }}>
            {attempt.recipientEmail}
          </Typography>
          {attempt.isTestEmail && attempt.originalRecipient && (
            <Typography level="body-xs" color="warning">
              ({attempt.originalRecipient})
            </Typography>
          )}
        </>
      ),
    },
    {
      id: 'subject',
      label: 'Subject',
      render: attempt => (
        <Typography level="body-xs" color={attempt.renderedSubject ? undefined : 'neutral'}>
          {attempt.renderedSubject || '-'}
        </Typography>
      ),
    },
    {
      id: 'opened',
      label: 'Opened',
      width: '8rem',
      render: attempt => <EventTime at={attempt.openedAt} color="success" />,
    },
    {
      id: 'clicked',
      label: 'Clicked',
      width: '8rem',
      render: attempt => <EventTime at={attempt.clickedAt} color="primary" />,
    },
    {
      id: 'sentBy',
      label: 'Sent by',
      width: '7rem',
      render: attempt => <Typography level="body-xs">{attempt.sentBy || '-'}</Typography>,
    },
  ];

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography level="title-md">Activity History</Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => refetch()}
          aria-label="Refresh activity"
          data-testid="email-activity-refresh-btn"
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-end', mb: 2 }}>
        <FormControl sx={{ flex: 1, minWidth: 200 }}>
          <FormLabel>Search Email or Subject</FormLabel>
          <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} size="sm" />
        </FormControl>
        <FormControl sx={{ minWidth: 150 }}>
          <FormLabel>Status</FormLabel>
          <Select
            value={statusFilter}
            onChange={(_, value) => {
              setStatusFilter(value as string);
              setPage(1);
            }}
            size="sm"
          >
            <Option value="all">All</Option>
            <Option value={EmailSendStatus.SENT}>Sent</Option>
            <Option value={EmailSendStatus.PENDING}>Pending</Option>
            <Option value={EmailSendStatus.PROCESSING}>Processing</Option>
            <Option value={EmailSendStatus.QUEUED}>Queued</Option>
            <Option value={EmailSendStatus.FAILED}>Failed</Option>
            <Option value={EmailSendStatus.CANCELLED}>Cancelled</Option>
            <Option value={EmailSendStatus.OPENED}>Opened</Option>
            <Option value={EmailSendStatus.CLICKED}>Clicked</Option>
          </Select>
        </FormControl>
        <FormControl sx={{ minWidth: 150 }}>
          <FormLabel>Start Date</FormLabel>
          <OptionalDateInput
            size="sm"
            value={startDate}
            onChange={day => {
              setStartDate(day);
              setPage(1);
            }}
            emptyLabel="From any date"
            setLabel="Set start date"
            clearLabel="Remove start date"
            initialDate={() => (endDate && endDate < todayUtc() ? endDate : todayUtc())}
            max={endDate || undefined}
            aria-label="Start date"
            testId="email-activity-start-date"
          />
        </FormControl>
        <FormControl sx={{ minWidth: 150 }}>
          <FormLabel>End Date</FormLabel>
          <OptionalDateInput
            size="sm"
            value={endDate}
            onChange={day => {
              setEndDate(day);
              setPage(1);
            }}
            emptyLabel="To any date"
            setLabel="Set end date"
            clearLabel="Remove end date"
            initialDate={() => (startDate && startDate > todayUtc() ? startDate : todayUtc())}
            min={startDate || undefined}
            aria-label="End date"
            testId="email-activity-end-date"
          />
        </FormControl>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 150 }}>
          <Checkbox
            checked={excludeTest}
            onChange={e => {
              setExcludeTest(e.target.checked);
              setPage(1);
            }}
            size="sm"
          />
          <Typography level="body-sm">Exclude Test Emails</Typography>
        </Box>
      </Box>

      <DataTable<IEmailSendAttemptDocument>
        label="Email activity"
        testId="email-activity-table"
        minWidth="74.5rem"
        rows={attempts}
        columns={columns}
        getRowId={attempt => attempt.id}
        loading={isLoading || isPlaceholderData}
        // A failed background refetch keeps the last rows on screen instead of swapping in the error.
        error={isError && !historyData ? 'Could not load activity.' : undefined}
        onRetry={() => void refetch()}
        empty={
          <EmptyState title="No email history found" description="Send emails to see activity here" action={null} />
        }
        pagination={{
          page,
          pageSize: limit,
          total,
          onPageChange: setPage,
          onPageSizeChange: size => {
            setLimit(size);
            setPage(1);
          },
        }}
        rowActions={
          onViewAttempt
            ? attempt => (
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => onViewAttempt(attempt.id)}
                  aria-label="View email"
                  data-testid={`email-activity-view-${attempt.id}`}
                >
                  <VisibilityIcon fontSize="small" />
                </IconButton>
              )
            : undefined
        }
      />
    </Sheet>
  );
}
