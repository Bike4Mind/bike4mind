import { useEffect, useState } from 'react';
import IconButton from '@mui/joy/IconButton';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ClaudeImportKind, ClaudeImportState } from '@shared/claudeImport';
import { ReloadIcon } from './icons';
import { timeAgo } from './prBarModel';

/**
 * Where the sidebar's Bike4Mind web sync stands. Web rows reach the list only through this sync
 * (main/claudeImport/WebSessionSync), never through the account menu's "Open Bike4Mind web".
 */
export type WebSyncLine =
  { kind: 'off' } | { kind: 'syncing' } | { kind: 'failed' } | { kind: 'never' } | { kind: 'synced'; ago: string };

export function webSyncLine(state: ClaudeImportState | null, now: number): WebSyncLine | null {
  if (!state?.signedIn) return null;
  const { web } = state;
  // A probe that found no notebooks means there is nothing on the web to bring here.
  if (!web.settings.enabled) return state.hints.webNotebooks === 0 ? null : { kind: 'off' };
  if (web.running) return { kind: 'syncing' };
  if (web.error) return { kind: 'failed' };
  const ago = web.lastSyncAt ? timeAgo(web.lastSyncAt, now) : null;
  return ago ? { kind: 'synced', ago } : { kind: 'never' };
}

// Fixed height so the line does not jump when the action switches between a link and an icon button.
const LINE_SX = {
  pl: 1,
  pr: 0.5,
  mt: 0.75,
  height: 24,
  gap: 1,
  alignItems: 'center',
  justifyContent: 'space-between',
} as const;

/** Re-renders once a minute so "5m ago" keeps counting while the sidebar sits open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** One quiet line above the session list; renders nothing when signed out. */
export function WebSyncStatus({
  state,
  onSyncNow,
  onOpenSettings,
}: {
  state: ClaudeImportState | null;
  onSyncNow: () => void;
  onOpenSettings: (focus: ClaudeImportKind) => void;
}) {
  const now = useMinuteClock();
  const line = webSyncLine(state, now);
  if (!line) return null;

  const action = (label: string, onClick: () => void, testId: string) => (
    <Link
      level="body-xs"
      component="button"
      color="neutral"
      underline="always"
      onClick={onClick}
      sx={{ flexShrink: 0, mr: 0.5 }}
      data-testid={testId}
    >
      {label}
    </Link>
  );

  return (
    <Stack direction="row" sx={LINE_SX} data-testid="sidebar-web-sync-status" data-kind={line.kind}>
      <Typography
        level="body-xs"
        textColor={line.kind === 'failed' ? 'danger.plainColor' : 'text.tertiary'}
        noWrap
        sx={{ minWidth: 0 }}
        data-testid="sidebar-web-sync-text"
      >
        {line.kind === 'off' && 'Web conversations not synced'}
        {line.kind === 'syncing' && 'Syncing from web...'}
        {line.kind === 'failed' && 'Could not sync from web'}
        {line.kind === 'never' && 'Not synced from web yet'}
        {line.kind === 'synced' && `Synced from web - ${line.ago}`}
      </Typography>
      {line.kind === 'off' && action('Set up', () => onOpenSettings('b4m-web'), 'sidebar-web-sync-setup-btn')}
      {line.kind === 'failed' && action('Retry', onSyncNow, 'sidebar-web-sync-now-btn')}
      {line.kind === 'never' && action('Sync now', onSyncNow, 'sidebar-web-sync-now-btn')}
      {line.kind === 'synced' && (
        <Tooltip title="Sync now" placement="right" variant="soft" size="sm">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Sync now"
            onClick={onSyncNow}
            sx={{ '--IconButton-size': '22px', minHeight: 22, color: 'text.tertiary' }}
            data-testid="sidebar-web-sync-now-btn"
          >
            <ReloadIcon />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
