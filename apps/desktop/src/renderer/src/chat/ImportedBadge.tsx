import Chip from '@mui/joy/Chip';
import Tooltip from '@mui/joy/Tooltip';
import type { ChatImportOrigin } from '@shared/claudeImport';

const SOURCE: Record<ChatImportOrigin['kind'], { name: string; chip: string; synced: boolean }> = {
  'claude-code': { name: 'Claude Code', chip: 'CC', synced: true },
  'claude-chat': { name: 'Claude', chip: 'Claude', synced: false },
  'b4m-web': { name: 'Bike4Mind web', chip: 'Web', synced: true },
};

/**
 * A web chat stays synced when the user sends in it (the message goes to the web session), so it
 * reads as synced; only the local-only paths stop that.
 */
export function importedBadgeLabel(origin: ChatImportOrigin): string {
  const source = SOURCE[origin.kind];
  if (origin.kind === 'b4m-web')
    return origin.forkedAt ? 'Imported from Bike4Mind web. No longer synced.' : 'Synced with web';
  return origin.forkedAt
    ? `Imported from ${source.name}. Continued here, so it no longer syncs.`
    : `Imported from ${source.name}${source.synced ? '. Kept in sync until you continue it here.' : '.'}`;
}

/** The row's "imported" marker, and whether it still follows its source. */
export function ImportedBadge({ origin }: { origin: ChatImportOrigin }) {
  const source = SOURCE[origin.kind];
  const label = importedBadgeLabel(origin);
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
