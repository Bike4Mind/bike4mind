import React from 'react';
import { Link, Stack, Typography } from '@mui/joy';
import type { AdminUserRiskFlag } from '@bike4mind/common';

type UserRiskBadgeEvidenceProps = {
  flag: AdminUserRiskFlag;
  onViewTimeline: (flag: AdminUserRiskFlag) => void;
  onViewCompliance: () => void;
};

const formatWindow = ({ from, to }: AdminUserRiskFlag['window']) => `${from.slice(0, 10)} to ${to.slice(0, 10)} (UTC)`;

/** The rule that fired and the raw rows behind it, so an admin can verify a flag instead of trusting it. */
export const UserRiskBadgeEvidence: React.FC<UserRiskBadgeEvidenceProps> = ({
  flag,
  onViewTimeline,
  onViewCompliance,
}) => (
  <Stack gap={1} sx={{ pt: 1.5 }} data-testid="user-risk-badge-evidence">
    <Typography level="body-sm">{flag.rule}</Typography>
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
      Window: {formatWindow(flag.window)}
    </Typography>
    <Stack component="dl" gap={0.5} sx={{ m: 0 }}>
      {flag.evidence.map((row, index) => (
        <Stack key={`${row.label}-${index}`} direction="row" gap={1.5} data-testid="user-risk-badge-evidence-row">
          <Typography component="dt" level="body-xs" sx={{ minWidth: 140, color: 'admin.inkMuted' }}>
            {row.label}
          </Typography>
          <Typography component="dd" level="body-sm" sx={{ m: 0, overflowWrap: 'anywhere' }}>
            {row.value}
          </Typography>
        </Stack>
      ))}
    </Stack>
    {flag.timeline && (
      <Link
        component="button"
        type="button"
        level="body-sm"
        onClick={() => onViewTimeline(flag)}
        sx={{ alignSelf: 'flex-start' }}
        data-testid="user-risk-badge-timeline-link"
      >
        View in timeline
      </Link>
    )}
    {flag.id === 'prior_moderation' && (
      <Link
        component="button"
        type="button"
        level="body-sm"
        onClick={onViewCompliance}
        sx={{ alignSelf: 'flex-start' }}
        data-testid="user-risk-badge-compliance-link"
      >
        Open compliance
      </Link>
    )}
  </Stack>
);
