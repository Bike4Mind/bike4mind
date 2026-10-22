import Chip from '@mui/joy/Chip';
import Tooltip from '@mui/joy/Tooltip';
import type { ChatImportOrigin } from '@shared/claudeImport';

/** The row's "came from Claude" marker, and whether it still follows its source. */
export function ImportedBadge({ origin }: { origin: ChatImportOrigin }) {
  const source = origin.kind === 'claude-code' ? 'Claude Code' : 'Claude';
  const label = origin.forkedAt
    ? `Imported from ${source}. Continued here, so it no longer syncs.`
    : `Imported from ${source}${origin.kind === 'claude-code' ? '. Kept in sync until you continue it here.' : '.'}`;
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
        {origin.kind === 'claude-code' ? 'CC' : 'Claude'}
      </Chip>
    </Tooltip>
  );
}
