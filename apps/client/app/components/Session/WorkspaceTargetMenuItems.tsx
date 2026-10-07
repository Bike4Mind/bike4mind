import type { SurfaceId, WorkspaceSurface, WorkspaceSurfaceIconKey } from '@bike4mind/common';
import { ListItemDecorator, MenuItem, Typography } from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import InsightsIcon from '@mui/icons-material/Insights';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { FC, ReactNode } from 'react';

const WORKSPACE_ICONS: Record<WorkspaceSurfaceIconKey, ReactNode> = {
  notebook: <MenuBookIcon />,
  opti: <InsightsIcon />,
};

/** Test-id suffix for a workspace: the surface string, or `main` for the main notebook list. */
export const workspaceTestIdSuffix = (id: SurfaceId): string => id ?? 'main';

/**
 * A labelled group of menu items, one per workspace, for the "Clone into" / "Fork into" /
 * "Move to" session actions. `currentId`, when given, is checked; the caller orders `targets`.
 */
const WorkspaceTargetMenuItems: FC<{
  label: string;
  targets: WorkspaceSurface[];
  currentId?: SurfaceId;
  /** Prefix of each item's data-testid, completed with `-<surface>` (see workspaceTestIdSuffix). */
  testIdPrefix: string;
  onSelect: (target: WorkspaceSurface) => void;
  disabled?: boolean;
}> = ({ label, targets, currentId, testIdPrefix, onSelect, disabled }) => (
  <>
    <Typography
      level="body-xs"
      data-testid={`${testIdPrefix}-label`}
      sx={{ px: 1.5, pt: 0.75, pb: 0.25, color: 'text.tertiary', fontWeight: 600 }}
    >
      {label}
    </Typography>
    {targets.map(target => (
      <MenuItem
        key={workspaceTestIdSuffix(target.id)}
        data-testid={`${testIdPrefix}-${workspaceTestIdSuffix(target.id)}`}
        onClick={() => onSelect(target)}
        disabled={disabled}
        sx={{ pl: 2.5 }}
      >
        <ListItemDecorator>{WORKSPACE_ICONS[target.iconKey]}</ListItemDecorator>
        {target.label}
        {currentId !== undefined && target.id === currentId && (
          <CheckIcon fontSize="small" sx={{ ml: 'auto' }} aria-label="current workspace" />
        )}
      </MenuItem>
    ))}
  </>
);

export default WorkspaceTargetMenuItems;
