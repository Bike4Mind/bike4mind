import React, { useState } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import type { AdminUserRiskFlag, AdminUserRiskFlagId, AdminUserRiskSeverity } from '@bike4mind/common';
import { useUserRiskFlags } from '@client/app/hooks/data/useUserRiskFlags';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { StatusChip } from '../../shared';
import { activitySearchFromFilters } from './activitySearch';
import { UserRiskBadgeEvidence } from './UserRiskBadgeEvidence';

const FLAG_LABELS: Record<AdminUserRiskFlagId, string> = {
  failed_sign_ins: 'Repeated failed sign-ins',
  new_ip_or_device: 'New IP or device',
  credit_spike: 'Credit spend spike',
  prior_moderation: 'Prior moderation',
};

const SEVERITY_TONES: Record<AdminUserRiskSeverity, AdminStatusTone> = { info: 'info', warn: 'warn', high: 'bad' };

type UserRiskBadgesProps = { userId: string; onOpenCompliance: () => void };

/** Rule-based risk flags for one user; each badge opens the rule and raw evidence behind it. */
export const UserRiskBadges: React.FC<UserRiskBadgesProps> = ({ userId, onOpenCompliance }) => {
  const risk = useUserRiskFlags(userId);
  const navigate = useNavigate({ from: '/admin/users/$userId' });
  const [openId, setOpenId] = useState<AdminUserRiskFlagId | null>(null);

  if (risk.isLoading || risk.isError || !risk.data) return null;
  const flags = risk.data.flags;
  const open = flags.find(flag => flag.id === openId);

  const viewTimeline = (flag: AdminUserRiskFlag) => {
    if (!flag.timeline) return;
    const filters = {
      types: flag.timeline.types,
      from: flag.timeline.from.slice(0, 10),
      to: flag.timeline.to.slice(0, 10),
    };
    void navigate({ search: previous => ({ ...previous, tab: 'activity', ...activitySearchFromFilters(filters) }) });
  };

  return (
    <Box component="section" aria-label="Risk flags" data-testid="user-risk-badges">
      {flags.length === 0 ? (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="user-risk-badges-empty">
          No risk flags
        </Typography>
      ) : (
        <Stack direction="row" gap={1} flexWrap="wrap">
          {flags.map(flag => (
            <Box
              component="button"
              type="button"
              key={flag.id}
              aria-expanded={openId === flag.id}
              onClick={() => setOpenId(openId === flag.id ? null : flag.id)}
              sx={{ p: 0, border: 0, bgcolor: 'transparent', cursor: 'pointer', borderRadius: 12 }}
              data-testid={`user-risk-badge-${flag.id}`}
            >
              <StatusChip tone={SEVERITY_TONES[flag.severity]} label={FLAG_LABELS[flag.id]} dot />
            </Box>
          ))}
        </Stack>
      )}
      {open && <UserRiskBadgeEvidence flag={open} onViewTimeline={viewTimeline} onViewCompliance={onOpenCompliance} />}
    </Box>
  );
};
