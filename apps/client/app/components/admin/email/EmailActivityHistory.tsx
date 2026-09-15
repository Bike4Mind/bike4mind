import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Sheet,
  Table,
  Chip,
  IconButton,
  FormControl,
  FormLabel,
  Input,
  Select,
  Option,
  Checkbox,
  CircularProgress,
  Button,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useEmailJobHistory } from '@client/app/hooks/data/emailMarketing';
import { EmailSendStatus, IEmailSendAttemptDocument } from '@bike4mind/common';

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

export default function EmailActivityHistory({ jobId, onViewAttempt }: EmailActivityHistoryProps) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
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
  const meta = historyData?.meta || { currentPage: 1, totalPages: 0, total: 0 };

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography level="title-md">Activity History</Typography>
        <IconButton size="sm" variant="plain" color="neutral" onClick={() => refetch()}>
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
            <Option value={EmailSendStatus.FAILED}>Failed</Option>
            <Option value={EmailSendStatus.CANCELLED}>Cancelled</Option>
            <Option value={EmailSendStatus.OPENED}>Opened</Option>
            <Option value={EmailSendStatus.CLICKED}>Clicked</Option>
          </Select>
        </FormControl>
        <FormControl sx={{ minWidth: 150 }}>
          <FormLabel>Start Date</FormLabel>
          <Input
            type="date"
            value={startDate}
            onChange={e => {
              setStartDate(e.target.value);
              setPage(1);
            }}
            size="sm"
          />
        </FormControl>
        <FormControl sx={{ minWidth: 150 }}>
          <FormLabel>End Date</FormLabel>
          <Input
            type="date"
            value={endDate}
            onChange={e => {
              setEndDate(e.target.value);
              setPage(1);
            }}
            size="sm"
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

      {/* Table */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : attempts.length === 0 ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography level="body-lg">No email history found</Typography>
          <Typography level="body-sm" sx={{ mt: 1, color: 'neutral.500' }}>
            Send emails to see activity here
          </Typography>
        </Box>
      ) : (
        <>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="sm">
              <thead>
                <tr>
                  <th style={{ width: '130px' }}>Time</th>
                  <th style={{ width: '90px' }}>Status</th>
                  <th style={{ width: '20%' }}>Recipient</th>
                  <th style={{ width: '25%' }}>Subject</th>
                  <th style={{ width: '90px' }}>Opened</th>
                  <th style={{ width: '90px' }}>Clicked</th>
                  <th style={{ width: '80px' }}>Sent By</th>
                  <th style={{ width: '50px' }}>View</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt: IEmailSendAttemptDocument) => (
                  <tr key={attempt.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Typography level="body-xs">{new Date(attempt.createdAt).toLocaleString()}</Typography>
                    </td>
                    <td>
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
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontWeight: attempt.isTestEmail ? 'bold' : 'normal' }}>
                        {attempt.recipientEmail}
                      </Typography>
                      {attempt.isTestEmail && attempt.originalRecipient && (
                        <Typography level="body-xs" color="warning">
                          ({attempt.originalRecipient})
                        </Typography>
                      )}
                    </td>
                    <td>
                      {attempt.renderedSubject ? (
                        <Typography
                          level="body-xs"
                          sx={{
                            maxWidth: '100%',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: 'block',
                          }}
                        >
                          {attempt.renderedSubject}
                        </Typography>
                      ) : (
                        <Typography level="body-xs" color="neutral">
                          -
                        </Typography>
                      )}
                    </td>
                    <td>
                      {attempt.openedAt ? (
                        <Typography level="body-xs" color="success">
                          {new Date(attempt.openedAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Typography>
                      ) : (
                        <Typography level="body-xs" color="neutral">
                          -
                        </Typography>
                      )}
                    </td>
                    <td>
                      {attempt.clickedAt ? (
                        <Typography level="body-xs" color="primary">
                          {new Date(attempt.clickedAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Typography>
                      ) : (
                        <Typography level="body-xs" color="neutral">
                          -
                        </Typography>
                      )}
                    </td>
                    <td>
                      <Typography level="body-xs">{attempt.sentBy || '-'}</Typography>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {onViewAttempt && (
                        <IconButton size="sm" variant="plain" color="neutral" onClick={() => onViewAttempt(attempt.id)}>
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>

          {/* Pagination */}
          {meta.totalPages > 1 && (
            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2 }}>
              <Button size="sm" variant="outlined" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                Previous
              </Button>
              <Typography level="body-sm">
                Page {meta.currentPage} of {meta.totalPages} ({meta.total} items)
              </Typography>
              <Button
                size="sm"
                variant="outlined"
                disabled={page >= meta.totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </Button>
              <Select
                value={limit}
                onChange={(_, value) => {
                  setLimit(value as number);
                  setPage(1);
                }}
                size="sm"
                sx={{ minWidth: 80 }}
              >
                <Option value={10}>10</Option>
                <Option value={25}>25</Option>
                <Option value={50}>50</Option>
              </Select>
              <Typography level="body-xs">per page</Typography>
            </Box>
          )}
        </>
      )}
    </Sheet>
  );
}
