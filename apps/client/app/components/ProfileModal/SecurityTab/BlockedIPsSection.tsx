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
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';

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

const BlockedIPsSection: React.FC = () => {
  const theme = useTheme();
  const blockedIPs = useGetBlockedIPs();
  const [blockOpen, setBlockOpen] = useState(false);
  const [unblocking, setUnblocking] = useState<BlockedIPItem | null>(null);

  const items = blockedIPs.data ?? [];

  return (
    <Box data-testid="blocked-ips-section">
      <SectionContainer
        title={
          <Stack direction="row" alignItems="center" gap={1}>
            <BlockIcon sx={{ color: theme.palette.security[items.length > 0 ? 'high' : 'good'].plainColor }} />
            <Typography level="title-md">Blocked IP addresses</Typography>
            <Chip
              size="sm"
              variant="soft"
              data-testid="blocked-ips-section-count"
              sx={{
                backgroundColor:
                  items.length > 0 ? theme.palette.security.high.softBg : theme.palette.security.good.softBg,
                color: items.length > 0 ? theme.palette.security.high.softColor : theme.palette.security.good.softColor,
              }}
            >
              {items.length} blocked
            </Chip>
          </Stack>
        }
        action={
          <Button size="sm" onClick={() => setBlockOpen(true)} data-testid="blocked-ips-section-block-btn">
            Block IP
          </Button>
        }
        subtitle="System-wide sign-in lockouts and admin blocks of an address or range, visible to administrators only. A block of sign-in, signup, checkout and AI also stops new accounts, purchases and AI usage from that network."
      >
        {blockedIPs.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size="sm" />
          </Box>
        ) : blockedIPs.isError ? (
          <Typography level="body-sm" color="danger" role="alert">
            Could not load blocked IP addresses.
          </Typography>
        ) : items.length === 0 ? (
          <Stack direction="row" alignItems="center" gap={1}>
            <CheckCircle fontSize="small" sx={{ color: theme.palette.security.good.plainColor }} />
            <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary }}>
              No IPs are currently blocked
            </Typography>
          </Stack>
        ) : (
          <Box data-testid="blocked-ips-section-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {items.map((item, index) => (
              <BlockedIPRow key={item._id} item={item} index={index} onUnblock={() => setUnblocking(item)} />
            ))}
          </Box>
        )}
      </SectionContainer>

      {blockOpen && <BlockIpDialog onClose={() => setBlockOpen(false)} />}
      <UnblockIpDialog block={unblocking} onClose={() => setUnblocking(null)} />
    </Box>
  );
};

export default BlockedIPsSection;
