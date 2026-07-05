import React from 'react';
import { Box, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import { Block as BlockIcon, CheckCircle } from '@mui/icons-material';
import { useGetBlockedIPs } from '@client/app/hooks/data/admin';

const BlockedIPsTab: React.FC = () => {
  const theme = useTheme();
  const blockedIPs = useGetBlockedIPs();

  const items = blockedIPs.data ?? [];

  return (
    <Box data-testid="blocked-ips-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <BlockIcon sx={{ color: theme.palette.security[items.length > 0 ? 'high' : 'good'].plainColor }} />
          <Typography level="title-md">Blocked IP Addresses</Typography>
          <Chip
            size="sm"
            variant="soft"
            data-testid="blocked-ips-tab-count"
            sx={{
              backgroundColor:
                items.length > 0 ? theme.palette.security.high.softBg : theme.palette.security.good.softBg,
              color: items.length > 0 ? theme.palette.security.high.softColor : theme.palette.security.good.softColor,
            }}
          >
            {items.length} blocked
          </Chip>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          IP addresses currently blocked from accessing your account
        </Typography>
      </Sheet>

      {/* List */}
      {blockedIPs.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" />
        </Box>
      ) : items.length === 0 ? (
        <Sheet
          variant="soft"
          sx={{
            borderRadius: 'md',
            p: 4,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <CheckCircle sx={{ color: theme.palette.security.good.plainColor, fontSize: 32 }} />
          <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
            No IPs are currently blocked
          </Typography>
        </Sheet>
      ) : (
        <Box data-testid="blocked-ips-tab-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {items.map((item, idx) => (
            <Sheet
              key={item.ip}
              variant="outlined"
              data-testid={`blocked-ip-${idx}`}
              sx={{
                borderRadius: 'md',
                p: 2,
                borderLeft: `3px solid ${theme.palette.security.high.outlinedBorder}`,
              }}
            >
              <Typography level="body-sm" fontWeight="md">
                {item.ip}
              </Typography>
              {item.reason && (
                <Typography level="body-xs" sx={{ color: theme.palette.text.secondary }}>
                  Reason: {item.reason}
                </Typography>
              )}
              <Typography level="body-xs" sx={{ color: theme.palette.text.tertiary }}>
                Blocked: {new Date(item.blockedAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
              </Typography>
            </Sheet>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default BlockedIPsTab;
