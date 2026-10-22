import { Chip, Tooltip } from '@mui/joy';
import { DRAFT_LAKE_TOOLTIP } from './lakeVisibility';

/**
 * Draft marker for a lake row: the Explorer's tree folders and lake picker, and the manager's lake
 * list. Callers gate it on isDraftLake (lakeVisibility.ts) so they agree on WHICH lakes are drafts.
 * The selected-lake header keeps its own longer-worded chip.
 */
export default function LakeDraftChip({ testId, tooltip = DRAFT_LAKE_TOOLTIP }: { testId: string; tooltip?: string }) {
  return (
    <Tooltip title={tooltip} size="sm">
      <Chip size="sm" variant="soft" color="warning" data-testid={testId} sx={{ fontSize: '11px', flexShrink: 0 }}>
        Draft
      </Chip>
    </Tooltip>
  );
}
