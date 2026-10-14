import { FC } from 'react';
import { Chip, Tooltip } from '@mui/joy';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import BlockIcon from '@mui/icons-material/Block';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import type { ISkillMarketStatus } from '@bike4mind/common';

/** Label + color for an imported skill's market state, shared with the slash-command picker. */
export function marketStatusBadge(
  status: ISkillMarketStatus | undefined
): { label: string; color: 'primary' | 'danger' | 'neutral'; hint: string } | null {
  if (!status) return null;
  if (status.state === 'stale') {
    return {
      label: `Update available (v${status.importedVersion} -> v${status.latestVersion})`,
      color: 'primary',
      hint: 'The author published a reviewed update. Open the skill to see what changed.',
    };
  }
  if (status.state === 'delisted') {
    return {
      label: 'Delisted by moderators',
      color: 'danger',
      hint: 'Moderators removed this skill from the market. Your copy still works; review it before relying on it.',
    };
  }
  if (status.state === 'removed') {
    return {
      label: 'No longer available',
      color: 'neutral',
      hint: 'The author withdrew this skill from the market. Your copy is unaffected.',
    };
  }
  return null;
}

const ICON = { primary: <SystemUpdateAltIcon />, danger: <BlockIcon />, neutral: <LinkOffIcon /> };

const MarketStatusBadge: FC<{ status?: ISkillMarketStatus; size?: 'sm' | 'md' }> = ({ status, size = 'sm' }) => {
  const badge = marketStatusBadge(status);
  if (!badge) return null;
  return (
    <Tooltip title={badge.hint} variant="soft">
      <Chip
        size={size}
        variant="soft"
        color={badge.color}
        startDecorator={ICON[badge.color]}
        data-testid={`market-status-${status!.state}`}
      >
        {badge.label}
      </Chip>
    </Tooltip>
  );
};

export default MarketStatusBadge;
