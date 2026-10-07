import { Tooltip } from '@mui/joy';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { lakeOwnerLabel } from './lakeVisibility';

export default function LakeOwnerIcon({ lake, testId }: { lake: { ownerDisplayName?: string }; testId: string }) {
  const label = lakeOwnerLabel(lake);
  return (
    <Tooltip size="sm" title={label}>
      <PersonOutlineIcon
        data-testid={testId}
        role="img"
        aria-hidden={false}
        aria-label={label}
        sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }}
      />
    </Tooltip>
  );
}
