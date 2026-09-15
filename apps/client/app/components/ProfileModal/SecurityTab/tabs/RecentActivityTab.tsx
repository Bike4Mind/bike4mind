import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import { History as HistoryIcon, Lock, Warning } from '@mui/icons-material';
import { useGetAllRecentSecurityEvents } from '@client/app/hooks/data/admin';
import type { UserSecurityEvent, SuspiciousPatternSummary } from '@client/app/hooks/data/admin';
import type { IAuthFailLogDocument } from '@bike4mind/database';

const RecentActivityTab: React.FC = () => {
  const theme = useTheme();
  const events = useGetAllRecentSecurityEvents();

  const items: UserSecurityEvent[] = events.data?.items ?? [];

  return (
    <Box data-testid="recent-activity-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <HistoryIcon sx={{ color: theme.palette.security.neutral.plainColor }} />
          <Typography level="title-md">Recent Activity</Typography>
          <Chip size="sm" variant="soft" data-testid="recent-activity-tab-count">
            {items.length} event{items.length !== 1 ? 's' : ''}
          </Chip>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          Security events on your account in the last 7 days
        </Typography>
      </Sheet>

      {/* List */}
      {events.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : items.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', p: 4, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
            No recent security events
          </Typography>
        </Sheet>
      ) : (
        <Box data-testid="recent-activity-tab-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((event, idx) => {
            const isSuspicious = event.type === 'suspicious_pattern';
            const suspiciousData = isSuspicious ? (event.data as SuspiciousPatternSummary) : null;
            const failedData = !isSuspicious ? (event.data as IAuthFailLogDocument) : null;
            return (
              <Sheet
                key={`${event.type}-${event.timestamp}-${idx}`}
                variant="soft"
                data-testid={`recent-activity-${event.type}-${idx}`}
                sx={{
                  borderRadius: 'md',
                  p: 2,
                  borderLeft: `3px solid ${isSuspicious ? theme.palette.security.high.outlinedBorder : theme.palette.security.critical.outlinedBorder}`,
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                  <Stack direction="row" gap={1} alignItems="center">
                    {isSuspicious ? (
                      <Warning fontSize="small" sx={{ color: theme.palette.security.high.plainColor }} />
                    ) : (
                      <Lock fontSize="small" sx={{ color: theme.palette.security.critical.plainColor }} />
                    )}
                    <Chip
                      size="sm"
                      variant="soft"
                      sx={{
                        backgroundColor: isSuspicious
                          ? theme.palette.security.high.softBg
                          : theme.palette.security.critical.softBg,
                        color: isSuspicious
                          ? theme.palette.security.high.softColor
                          : theme.palette.security.critical.softColor,
                      }}
                    >
                      {isSuspicious ? 'Suspicious pattern' : 'Failed login'}
                    </Chip>
                    <Typography level="body-sm" fontWeight="md">
                      {isSuspicious ? (suspiciousData?.ip ?? 'Unknown IP') : (failedData?.username ?? 'Unknown user')}
                    </Typography>
                  </Stack>
                  <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary, whiteSpace: 'nowrap' }}>
                    {new Date(event.timestamp).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                  </Typography>
                </Stack>
                {isSuspicious && suspiciousData && (
                  <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                    {suspiciousData.attempts} attempt{suspiciousData.attempts !== 1 ? 's' : ''} · Risk:{' '}
                    {suspiciousData.riskLevel}
                  </Typography>
                )}
                {!isSuspicious && failedData && (
                  <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                    IP: {failedData.ip ?? 'Unknown'} · {failedData.reason ?? ''}
                  </Typography>
                )}
              </Sheet>
            );
          })}
        </Box>
      )}

      {events.data && (
        <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary, textAlign: 'right' }}>
          Last updated: {new Date(events.data.since).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        </Typography>
      )}
    </Box>
  );
};

export default RecentActivityTab;
