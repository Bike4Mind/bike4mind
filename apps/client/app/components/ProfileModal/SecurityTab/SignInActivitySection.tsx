import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import Lock from '@mui/icons-material/Lock';
import Warning from '@mui/icons-material/Warning';
import type { IAuthFailLogDocument } from '@bike4mind/database';
import { useGetAllRecentSecurityEvents } from '@client/app/hooks/data/admin';
import type { UserSecurityEvent, SuspiciousPatternSummary } from '@client/app/hooks/data/admin';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';

const SEP = ' \u00b7 ';

const SignInActivitySection: React.FC = () => {
  const theme = useTheme();
  const events = useGetAllRecentSecurityEvents();

  const items: UserSecurityEvent[] = events.data?.items ?? [];

  return (
    <SectionContainer
      title={
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography level="title-md">Sign-in attempts (last 7 days)</Typography>
          <Chip size="sm" variant="soft" data-testid="security-signin-activity-count">
            {items.length}
          </Chip>
        </Stack>
      }
      subtitle="Failed sign-ins and suspicious attempts against your account."
    >
      {events.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : events.isError ? (
        <Typography level="body-sm" color="danger" role="alert">
          Could not load sign-in attempts.
        </Typography>
      ) : items.length === 0 ? (
        <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
          No failed sign-ins or suspicious attempts in the last 7 days
        </Typography>
      ) : (
        <Box data-testid="security-signin-activity-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((event, idx) => {
            const isSuspicious = event.type === 'suspicious_pattern';
            const suspiciousData = isSuspicious ? (event.data as SuspiciousPatternSummary) : null;
            const failedData = !isSuspicious ? (event.data as IAuthFailLogDocument) : null;
            const tone = isSuspicious ? theme.palette.security.high : theme.palette.security.critical;
            return (
              <Sheet
                key={`${event.type}-${event.timestamp}-${idx}`}
                variant="soft"
                data-testid={`security-signin-activity-${event.type}-${idx}`}
                sx={{ borderRadius: 'md', px: 2, py: 1.25, borderLeft: `3px solid ${tone.outlinedBorder}` }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                  <Stack direction="row" gap={1} alignItems="center">
                    {isSuspicious ? (
                      <Warning fontSize="small" sx={{ color: tone.plainColor }} />
                    ) : (
                      <Lock fontSize="small" sx={{ color: tone.plainColor }} />
                    )}
                    <Chip size="sm" variant="soft" sx={{ backgroundColor: tone.softBg, color: tone.softColor }}>
                      {isSuspicious ? 'Suspicious pattern' : 'Failed sign-in'}
                    </Chip>
                    <Typography level="body-sm" fontWeight="md">
                      {isSuspicious ? (suspiciousData?.ip ?? 'Unknown IP') : (failedData?.username ?? 'Unknown user')}
                    </Typography>
                  </Stack>
                  <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary, whiteSpace: 'nowrap' }}>
                    {new Date(event.timestamp).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                  </Typography>
                </Stack>
                {suspiciousData && (
                  <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                    {suspiciousData.attempts} attempt{suspiciousData.attempts !== 1 ? 's' : ''}
                    {SEP}Risk: {suspiciousData.riskLevel}
                  </Typography>
                )}
                {failedData && (
                  <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                    IP: {failedData.ip ?? 'Unknown'}
                    {failedData.reason ? `${SEP}${failedData.reason}` : ''}
                  </Typography>
                )}
              </Sheet>
            );
          })}
        </Box>
      )}
    </SectionContainer>
  );
};

export default SignInActivitySection;
