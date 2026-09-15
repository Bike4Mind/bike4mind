import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import { PersonSearch as PersonSearchIcon, Warning } from '@mui/icons-material';
import { useGetSuspiciousSummary, useGetRecentSuspiciousLogins } from '@client/app/hooks/data/admin';
import type { SuspiciousPatternSummary } from '@client/app/hooks/data/admin';

const getRiskLevelColor = (level: string): 'good' | 'high' | 'critical' => {
  if (level === 'high') return 'critical';
  if (level === 'medium') return 'high';
  return 'good';
};

const SuspiciousLoginsTab: React.FC = () => {
  const theme = useTheme();
  const summary = useGetSuspiciousSummary();
  const details = useGetRecentSuspiciousLogins();

  const total = summary.data?.total ?? 0;
  const items: SuspiciousPatternSummary[] = details.data?.items ?? [];
  const isLoading = summary.isLoading || details.isLoading;

  return (
    <Box data-testid="suspicious-logins-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <PersonSearchIcon sx={{ color: theme.palette.security[total > 0 ? 'high' : 'good'].plainColor }} />
          <Typography level="title-md">Suspicious Logins</Typography>
          <Chip
            size="sm"
            variant="soft"
            data-testid="suspicious-logins-tab-count"
            sx={{
              backgroundColor: total > 0 ? theme.palette.security.high.softBg : theme.palette.security.good.softBg,
              color: total > 0 ? theme.palette.security.high.softColor : theme.palette.security.good.softColor,
            }}
          >
            {total} detected
          </Chip>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          Suspicious login patterns detected in the last 24 hours
        </Typography>
      </Sheet>

      {/* List */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : items.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', p: 4, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
            No suspicious login patterns detected
          </Typography>
        </Sheet>
      ) : (
        <Box data-testid="suspicious-logins-tab-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((item, idx) => (
            <Sheet
              key={item.ip ?? String(idx)}
              variant="soft"
              data-testid={`suspicious-login-item-${idx}`}
              sx={{
                borderRadius: 'md',
                p: 2,
                borderLeft: `3px solid ${theme.palette.security.high.outlinedBorder}`,
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                <Stack direction="row" gap={1} alignItems="center">
                  <Warning fontSize="small" sx={{ color: theme.palette.security.high.plainColor }} />
                  <Typography level="body-sm" fontWeight="md">
                    {item.ip ?? 'Unknown IP'}
                  </Typography>
                  <Chip
                    size="sm"
                    variant="soft"
                    sx={{
                      backgroundColor: theme.palette.security[getRiskLevelColor(item.riskLevel)].softBg,
                      color: theme.palette.security[getRiskLevelColor(item.riskLevel)].softColor,
                    }}
                  >
                    {item.riskLevel}
                  </Chip>
                </Stack>
                <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                  Last: {new Date(item.lastAttempt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                </Typography>
              </Stack>
              <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                {item.attempts} attempt{item.attempts !== 1 ? 's' : ''} · Targeted your account
              </Typography>
              <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                First seen: {new Date(item.firstAttempt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
              </Typography>
            </Sheet>
          ))}
        </Box>
      )}

      {details.data && (
        <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary, textAlign: 'right' }}>
          Last updated: {new Date(details.data.since).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
        </Typography>
      )}
    </Box>
  );
};

export default SuspiciousLoginsTab;
