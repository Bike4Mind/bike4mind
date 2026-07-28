import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import { Key, Warning } from '@mui/icons-material';
import { useGetApiUsage } from '@client/app/hooks/data/admin';
import type { ApiKeyUsageItem } from '@client/app/hooks/data/admin';

/** Short "3h 12m" / "45m" / "30s" until an epoch-seconds reset; empty if absent or already past. */
const formatReset = (resetAtSeconds?: number): string => {
  if (!resetAtSeconds) return '';
  const remainingSeconds = resetAtSeconds - Math.floor(Date.now() / 1000);
  if (remainingSeconds <= 0) return '';
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainingSeconds}s`;
};

const ApiKeyStatusTab: React.FC = () => {
  const theme = useTheme();
  const apiUsage = useGetApiUsage();

  const keys: ApiKeyUsageItem[] = apiUsage.data ?? [];
  const keysWithAlerts = keys.filter(k => k.alerts && k.alerts.length > 0);

  return (
    <Box data-testid="api-key-status-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Key sx={{ color: theme.palette.security[keysWithAlerts.length > 0 ? 'high' : 'good'].plainColor }} />
          <Typography level="title-md">API Key Status</Typography>
          <Chip
            size="sm"
            variant="soft"
            data-testid="api-key-status-tab-count"
            sx={{
              backgroundColor:
                keysWithAlerts.length > 0 ? theme.palette.security.high.softBg : theme.palette.security.good.softBg,
              color:
                keysWithAlerts.length > 0
                  ? theme.palette.security.high.softColor
                  : theme.palette.security.good.softColor,
            }}
          >
            {keys.length} key{keys.length !== 1 ? 's' : ''} · {keysWithAlerts.length} alert
            {keysWithAlerts.length !== 1 ? 's' : ''}
          </Chip>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          API key activity and security alerts on your account
        </Typography>
      </Sheet>

      {/* List */}
      {apiUsage.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : keys.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', p: 4, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
            No API keys found
          </Typography>
        </Sheet>
      ) : (
        <Box data-testid="api-key-status-tab-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {keys.map((key, idx) => {
            const hasAlerts = key.alerts && key.alerts.length > 0;
            const statusColor: 'good' | 'high' | 'neutral' = hasAlerts
              ? 'high'
              : key.status === 'active'
                ? 'good'
                : 'neutral';
            const securityTokenColor: 'good' | 'high' | 'critical' = hasAlerts ? 'high' : 'good';
            return (
              <Sheet
                key={key.id}
                variant="outlined"
                data-testid={`api-key-status-item-${idx}`}
                sx={{
                  borderRadius: 'md',
                  p: 2,
                  borderLeft: `3px solid ${theme.palette.security[securityTokenColor].outlinedBorder}`,
                }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                  <Stack direction="row" gap={1} alignItems="center">
                    <Key
                      fontSize="small"
                      sx={{
                        color:
                          statusColor === 'neutral'
                            ? theme.palette.neutral.plainColor
                            : theme.palette.security[statusColor].plainColor,
                      }}
                    />
                    <Typography level="body-sm" fontWeight="md">
                      {key.name || 'Unnamed Key'}
                    </Typography>
                    <Chip size="sm" variant="soft">
                      {key.status}
                    </Chip>
                  </Stack>
                  <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                    {key.lastUsedAt ? `Last used: ${new Date(key.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  </Typography>
                </Stack>
                <Typography level="body-xs" sx={{ mt: 0.5, color: theme.palette.text.secondary }}>
                  Today: {key.liveUsage.day.toLocaleString()} / {key.rateLimit.requestsPerDay.toLocaleString()} requests
                  {key.liveUsage.day > 0 && formatReset(key.liveUsage.dayResetAt)
                    ? ` · resets in ${formatReset(key.liveUsage.dayResetAt)}`
                    : ''}
                </Typography>
                {hasAlerts && (
                  <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {key.alerts.map(alert => (
                      <Stack key={alert.id} direction="row" gap={0.75} alignItems="flex-start">
                        <Warning fontSize="small" sx={{ color: theme.palette.security.high.plainColor, mt: '1px' }} />
                        <Typography level="body-xs" sx={{ color: theme.palette.security.high.plainColor }}>
                          {alert.message}
                        </Typography>
                      </Stack>
                    ))}
                  </Box>
                )}
              </Sheet>
            );
          })}
        </Box>
      )}
    </Box>
  );
};

export default ApiKeyStatusTab;
