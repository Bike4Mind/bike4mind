import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import { Lock } from '@mui/icons-material';
import type { IAuthFailLogDocument } from '@bike4mind/database';
import { useGetFailedLoginCount, useGetRecentFailedLogins } from '@client/app/hooks/data/admin';

const FailedLoginsTab: React.FC = () => {
  const theme = useTheme();
  const count = useGetFailedLoginCount();
  const details = useGetRecentFailedLogins();

  const total = count.data?.total ?? 0;
  const items: IAuthFailLogDocument[] = details.data?.items ?? [];
  const isLoading = count.isLoading || details.isLoading;

  return (
    <Box data-testid="failed-logins-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Lock sx={{ color: theme.palette.security[total > 0 ? 'critical' : 'good'].plainColor }} />
          <Typography level="title-md">Failed Login Attempts</Typography>
          <Chip
            size="sm"
            variant="soft"
            data-testid="failed-logins-tab-count"
            sx={{
              backgroundColor: total > 0 ? theme.palette.security.critical.softBg : theme.palette.security.good.softBg,
              color: total > 0 ? theme.palette.security.critical.softColor : theme.palette.security.good.softColor,
            }}
          >
            {total} in last 24h
          </Chip>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          Failed authentication attempts on your account
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
            No failed login attempts in the last 24 hours
          </Typography>
        </Sheet>
      ) : (
        <Box data-testid="failed-logins-tab-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((item, idx) => (
            <Sheet
              key={`${item.ip ?? 'unknown'}-${item.createdAt}-${idx}`}
              variant="soft"
              sx={{
                borderRadius: 'md',
                p: 2,
                borderLeft: `3px solid ${theme.palette.security.critical.outlinedBorder}`,
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                <Stack direction="row" gap={1} alignItems="center">
                  <Lock fontSize="small" sx={{ color: theme.palette.security.critical.plainColor }} />
                  <Typography level="body-sm" fontWeight="md">
                    {item.username ?? 'Unknown user'}
                  </Typography>
                  {item.strategy && (
                    <Chip size="sm" variant="soft">
                      {item.strategy}
                    </Chip>
                  )}
                </Stack>
                <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                  {new Date(item.createdAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                </Typography>
              </Stack>
              <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                IP: {item.ip ?? 'Unknown'} · Reason: {item.reason ?? 'N/A'}
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

export default FailedLoginsTab;
