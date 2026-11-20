import Chip from '@mui/joy/Chip';
import Tooltip from '@mui/joy/Tooltip';
import type { ChatImportOrigin } from '@shared/claudeImport';

const SOURCE: Record<ChatImportOrigin['kind'], { name: string; chip: string; synced: boolean }> = {
  'claude-code': { name: 'Claude Code', chip: 'CC', synced: true },
  'claude-chat': { name: 'Claude', chip: 'Claude', synced: false },
  'b4m-web': { name: 'Bike4Mind web', chip: 'Web', synced: true },
};

/** The row's "imported" marker, and whether it still follows its source. */
export function ImportedBadge({ origin }: { origin: ChatImportOrigin }) {
  const source = SOURCE[origin.kind];
  const label = origin.forkedAt
    ? `Imported from ${source.name}. Continued here, so it no longer syncs.`
    : `Imported from ${source.name}${source.synced ? '. Kept in sync until you continue it here.' : '.'}`;
  return (
    <Tooltip title={label} size="sm" placement="right">
      <Chip
        size="sm"
        variant="soft"
        color={origin.forkedAt ? 'neutral' : 'primary'}
        sx={{ flexShrink: 0, ml: 'auto', fontSize: '0.625rem', minHeight: 16, px: 0.75 }}
        aria-label={label}
        data-testid="session-imported-badge"
        data-import-kind={origin.kind}
        data-import-forked={origin.forkedAt ? 'true' : 'false'}
      >
        {source.chip}
      </Chip>
    </Tooltip>
  );
}
