import { Chip, Tooltip } from '@mui/joy';

export const DRAFT_LAKE_TOOLTIP = 'Draft - grounds no answers until it is published';

/**
 * The one draft marker for every surface that lists a lake: the Explorer's tree rows, lake picker
 * and selected-lake header, and the manager's lake list. Callers gate it on isDraftLake
 * (lakeVisibility.ts) so they agree on WHICH lakes are drafts, and render this so they agree on
 * how one looks.
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
