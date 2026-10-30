import React, { useState } from 'react';
import { Box, Button, Chip, CircularProgress, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircle from '@mui/icons-material/CheckCircle';
import { isPermanentIpBlock } from '@bike4mind/common';
import { useGetBlockedIPs, type BlockedIPItem } from '@client/app/hooks/data/admin';
import { formatUtc, RelativeTime, StatusChip } from '@client/app/components/admin/shared';
import {
  BlockIpDialog,
  IP_BLOCK_SCOPE_LABELS,
  UnblockIpDialog,
} from '@client/app/components/admin/BlockedIPs/IpBlockDialogs';

const blockedBy = (item: BlockedIPItem): string =>
  item.blockedByName ?? (item.source === 'auto' ? 'Automatic (failed sign-ins)' : '-');

const expiryLabel = (expiresAt: string): string =>
  isPermanentIpBlock(expiresAt) ? 'Never' : formatUtc(new Date(expiresAt));

const BlockedIPRow: React.FC<{ item: BlockedIPItem; index: number; onUnblock: () => void }> = ({
  item,
  index,
  onUnblock,
}) => {
  const theme = useTheme();
  const scope = item.scope ?? 'login';
  return (
    <Sheet
      variant="outlined"
      data-testid={`blocked-ip-${index}`}
      sx={{ borderRadius: 'md', p: 2, borderLeft: `3px solid ${theme.palette.security.high.outlinedBorder}` }}
    >
      <Stack direction="row" alignItems="flex-start" gap={1.5}>
        <Stack gap={0.5} sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Typography level="body-sm" fontWeight="md" sx={{ fontFamily: 'code' }}>
              {item.ip}
            </Typography>
            <StatusChip
              tone={scope === 'all' ? 'bad' : 'warn'}
              label={IP_BLOCK_SCOPE_LABELS[scope]}
              data-testid={`blocked-ip-${index}-scope`}
            />
          </Stack>
          {item.reason && (
            <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, overflowWrap: 'anywhere' }}>
              Reason: {item.reason}
            </Typography>
          )}
          <Typography
            level="body-xs"
            sx={{ color: theme.palette.text.tertiary }}
            data-testid={`blocked-ip-${index}-by`}
          >
            Blocked by {blockedBy(item)} <RelativeTime at={item.blockedAt} />
          </Typography>
          <Typography
            level="body-xs"
            sx={{ color: theme.palette.text.tertiary }}
            data-testid={`blocked-ip-${index}-expiry`}
          >
            Ends: {expiryLabel(item.expiresAt)}
          </Typography>
        </Stack>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={onUnblock}
          aria-label={`Unblock ${item.ip}`}
          data-testid={`blocked-ip-${index}-unblock-btn`}
        >
          Unblock
        </Button>
      </Stack>
    </Sheet>
  );
};

const BlockedIPsTab: React.FC = () => {
  const theme = useTheme();
  const blockedIPs = useGetBlockedIPs();
  const [blockOpen, setBlockOpen] = useState(false);
  const [unblocking, setUnblocking] = useState<BlockedIPItem | null>(null);

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
          <Button
            size="sm"
            sx={{ ml: 'auto' }}
            onClick={() => setBlockOpen(true)}
            data-testid="blocked-ips-tab-block-btn"
          >
            Block IP
          </Button>
        </Stack>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          Sign-in lockouts and admin blocks of an address or range. A block of sign-in, signup, checkout and AI also
          stops new accounts, purchases and AI usage from that network.
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
          {items.map((item, index) => (
            <BlockedIPRow key={item._id} item={item} index={index} onUnblock={() => setUnblocking(item)} />
          ))}
        </Box>
      )}

      {blockOpen && <BlockIpDialog onClose={() => setBlockOpen(false)} />}
      <UnblockIpDialog block={unblocking} onClose={() => setUnblocking(null)} />
    </Box>
  );
};

export default BlockedIPsTab;
