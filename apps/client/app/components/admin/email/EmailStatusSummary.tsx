import React, { useState } from 'react';
import { Box, Typography, CircularProgress, IconButton, Stack, Chip, Tooltip, Checkbox } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import VisibilityIcon from '@mui/icons-material/Visibility';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import { useEmailJobSummary } from '@client/app/hooks/data/emailMarketing';

interface EmailStatusSummaryProps {
  jobId: string;
}

const StatusCard = ({
  label,
  value,
  testValue,
  color,
  rate,
  icon,
}: {
  label: string;
  value: number;
  testValue?: number;
  color?: 'success' | 'danger' | 'warning' | 'primary' | 'neutral';
  rate?: string;
  icon?: React.ReactNode;
}) => (
  <Box sx={{ textAlign: 'center', minWidth: 80 }}>
    <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
      {icon}
      <Typography level="body-xs" color={color}>
        {label}
      </Typography>
    </Stack>
    <Typography level="h3" color={color}>
      {value}
    </Typography>
    {rate && (
      <Chip size="sm" variant="soft" color={color || 'neutral'} sx={{ mt: 0.5 }}>
        {rate}
      </Chip>
    )}
    {testValue !== undefined && testValue > 0 && (
      <Typography
        level="body-xs"
        sx={{
          opacity: 0.8,
          color: color ? `${color}.600` : 'neutral.600',
          mt: 0.5,
        }}
      >
        {testValue} test
      </Typography>
    )}
  </Box>
);

export default function EmailStatusSummary({ jobId }: EmailStatusSummaryProps) {
  const [excludeTest, setExcludeTest] = useState(true); // Exclude test emails by default
  const { data: summary, isLoading, refetch } = useEmailJobSummary(jobId);

  if (isLoading || !summary) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  const {
    total: rawTotal,
    sent: rawSent,
    failed: rawFailed,
    pending: rawPending,
    processing: rawProcessing,
    cancelled: rawCancelled,
    testEmails,
    jobMetrics,
  } = summary;

  // Calculate values excluding test emails if checkbox is checked
  const total = excludeTest ? rawTotal - (testEmails?.total || 0) : rawTotal;
  const sent = excludeTest ? rawSent - (testEmails?.sent || 0) : rawSent;
  const failed = excludeTest ? rawFailed - (testEmails?.failed || 0) : rawFailed;
  const pending = excludeTest ? rawPending - (testEmails?.pending || 0) : rawPending;
  const processing = excludeTest ? rawProcessing - (testEmails?.processing || 0) : rawProcessing;
  const cancelled = excludeTest ? rawCancelled - (testEmails?.cancelled || 0) : rawCancelled;

  // Calculate percentages for progress bar
  const getPercentage = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  // Calculate rates
  const openRate = sent > 0 ? (((jobMetrics?.openedCount || 0) / sent) * 100).toFixed(1) + '%' : '-';
  const clickRate = sent > 0 ? (((jobMetrics?.clickedCount || 0) / sent) * 100).toFixed(1) + '%' : '-';
  const failureRate = total > 0 ? ((failed / total) * 100).toFixed(1) + '%' : '-';

  return (
    <Box>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography level="title-md">Email Status Summary</Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Checkbox size="sm" checked={excludeTest} onChange={e => setExcludeTest(e.target.checked)} />
            <Typography level="body-sm">Exclude Test Emails</Typography>
          </Box>
          {jobMetrics?.lastSentAt && (
            <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
              Last sent: {new Date(jobMetrics.lastSentAt).toLocaleString()}
            </Typography>
          )}
          <IconButton size="sm" variant="plain" color="neutral" onClick={() => refetch()}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>

      {/* Two-row layout: Delivery Status + Engagement Metrics */}
      <Stack direction="row" spacing={4} flexWrap="wrap">
        {/* Delivery Status */}
        <Box sx={{ flex: 1, minWidth: 300 }}>
          <Typography
            level="body-xs"
            sx={{ color: 'neutral.500', mb: 1, textTransform: 'uppercase', fontWeight: 'bold' }}
          >
            Delivery Status
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap">
            <StatusCard
              label="Total"
              value={total}
              testValue={testEmails?.total}
              icon={<MailOutlineIcon sx={{ fontSize: 14 }} />}
            />
            <StatusCard label="Sent" value={sent} testValue={testEmails?.sent} color="success" />
            <StatusCard
              label="Failed"
              value={failed}
              testValue={testEmails?.failed}
              color="danger"
              rate={failureRate !== '-' && failed > 0 ? failureRate : undefined}
            />
            <StatusCard label="Pending" value={pending} testValue={testEmails?.pending} color="warning" />
            <StatusCard label="Processing" value={processing} testValue={testEmails?.processing} color="primary" />
            {cancelled > 0 && (
              <StatusCard label="Cancelled" value={cancelled} testValue={testEmails?.cancelled} color="neutral" />
            )}
          </Stack>
        </Box>

        {/* Engagement Metrics */}
        <Box sx={{ minWidth: 200 }}>
          <Typography
            level="body-xs"
            sx={{ color: 'neutral.500', mb: 1, textTransform: 'uppercase', fontWeight: 'bold' }}
          >
            Engagement
          </Typography>
          <Stack direction="row" spacing={2}>
            <Tooltip title="Unique email opens">
              <Box>
                <StatusCard
                  label="Opened"
                  value={jobMetrics?.openedCount || 0}
                  color="success"
                  rate={openRate !== '-' ? openRate : undefined}
                  icon={<VisibilityIcon sx={{ fontSize: 14 }} />}
                />
              </Box>
            </Tooltip>
            <Tooltip title="Unique link clicks">
              <Box>
                <StatusCard
                  label="Clicked"
                  value={jobMetrics?.clickedCount || 0}
                  color="primary"
                  rate={clickRate !== '-' ? clickRate : undefined}
                  icon={<TouchAppIcon sx={{ fontSize: 14 }} />}
                />
              </Box>
            </Tooltip>
          </Stack>
        </Box>
      </Stack>

      {/* Progress Bar */}
      {total > 0 && (
        <Box sx={{ mt: 2 }}>
          <Box
            sx={{
              display: 'flex',
              height: '24px',
              width: '100%',
              borderRadius: 'sm',
              overflow: 'hidden',
            }}
          >
            {sent > 0 && (
              <Box
                sx={{
                  width: `${getPercentage(sent)}%`,
                  bgcolor: 'success.400',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: sent > total * 0.1 ? 'auto' : 0,
                }}
              >
                {sent > total * 0.1 && (
                  <Typography level="body-xs" sx={{ color: 'white', fontWeight: 'bold' }}>
                    {Math.round(getPercentage(sent))}%
                  </Typography>
                )}
              </Box>
            )}
            {failed > 0 && (
              <Box
                sx={{
                  width: `${getPercentage(failed)}%`,
                  bgcolor: 'danger.400',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: failed > total * 0.1 ? 'auto' : 0,
                }}
              >
                {failed > total * 0.1 && (
                  <Typography level="body-xs" sx={{ color: 'white', fontWeight: 'bold' }}>
                    {Math.round(getPercentage(failed))}%
                  </Typography>
                )}
              </Box>
            )}
            {pending > 0 && (
              <Box
                sx={{
                  width: `${getPercentage(pending)}%`,
                  bgcolor: 'warning.400',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: pending > total * 0.1 ? 'auto' : 0,
                }}
              >
                {pending > total * 0.1 && (
                  <Typography level="body-xs" sx={{ color: 'white', fontWeight: 'bold' }}>
                    {Math.round(getPercentage(pending))}%
                  </Typography>
                )}
              </Box>
            )}
            {processing > 0 && (
              <Box
                sx={{
                  width: `${getPercentage(processing)}%`,
                  bgcolor: 'primary.400',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: processing > total * 0.1 ? 'auto' : 0,
                }}
              >
                {processing > total * 0.1 && (
                  <Typography level="body-xs" sx={{ color: 'white', fontWeight: 'bold' }}>
                    {Math.round(getPercentage(processing))}%
                  </Typography>
                )}
              </Box>
            )}
            {cancelled > 0 && (
              <Box
                sx={{
                  width: `${getPercentage(cancelled)}%`,
                  bgcolor: 'neutral.400',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: cancelled > total * 0.1 ? 'auto' : 0,
                }}
              >
                {cancelled > total * 0.1 && (
                  <Typography level="body-xs" sx={{ color: 'white', fontWeight: 'bold' }}>
                    {Math.round(getPercentage(cancelled))}%
                  </Typography>
                )}
              </Box>
            )}
          </Box>

          {/* Legend */}
          <Box sx={{ display: 'flex', gap: 2, mt: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'success.400' }} />
              <Typography level="body-xs">Sent</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'danger.400' }} />
              <Typography level="body-xs">Failed</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'warning.400' }} />
              <Typography level="body-xs">Pending</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'primary.400' }} />
              <Typography level="body-xs">Processing</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'neutral.400' }} />
              <Typography level="body-xs">Cancelled</Typography>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
