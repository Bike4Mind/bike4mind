import { useId, type ReactNode } from 'react';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Link from '@mui/joy/Link';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  CLAUDE_EXPORT_HELP_URL,
  type ClaudeImportKind,
  type ClaudeImportState,
  type SyncHintId,
} from '@shared/claudeImport';
import { useClaudeImport } from './ClaudeImportSettings';
import { ArrowRightIcon, CloseIcon } from './icons';
import { WebSyncStatus } from './WebSyncStatus';
import claudeIcon from '../assets/claude.svg';
import bike4mindIcon from '../../favicon.png';

export interface EmptyCardOptions {
  code: boolean;
  chat: boolean;
  web: boolean;
}

export type SyncHintChoice = { kind: 'sidebar-empty'; options: EmptyCardOptions } | null;

/**
 * Keep onboarding in one empty-sidebar card; closing it must not reveal another prompt.
 */
export function pickSyncHint(state: ClaudeImportState | null, empty: boolean): SyncHintChoice {
  if (!state?.signedIn) return null;
  const { dismissed, codeSessions, webNotebooks } = state.hints;
  const open = (id: SyncHintId) => !dismissed.includes(id);
  const code = !state.code.settings.enabled && (codeSessions ?? 0) > 0;
  const web = !state.web.settings.enabled && (webNotebooks ?? 0) > 0;
  if (empty && open('sidebar-empty')) return { kind: 'sidebar-empty', options: { code, chat: true, web } };
  return null;
}

function HintCard({
  testId,
  heading,
  children,
  onClose,
  closeLabel,
}: {
  testId: string;
  heading: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
}) {
  const headingId = useId();
  return (
    <Sheet
      variant="outlined"
      role="region"
      aria-labelledby={headingId}
      data-testid={testId}
      sx={{ mx: 0.5, my: 1, p: 1.5, borderRadius: 'md', bgcolor: 'background.surface', borderColor: 'divider' }}
    >
      <Stack direction="row" alignItems="flex-start" sx={{ position: 'relative' }}>
        <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={headingId} level="title-sm" sx={{ pr: 3, lineHeight: 1.5 }}>
            {heading}
          </Typography>
          {children}
        </Stack>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onClose}
          aria-label={closeLabel}
          data-testid={`${testId}-close-btn`}
          sx={{ position: 'absolute', top: -4, right: -4, minWidth: 28, minHeight: 28, color: 'text.tertiary' }}
        >
          <CloseIcon />
        </IconButton>
      </Stack>
    </Sheet>
  );
}

export interface SyncHintsViewProps {
  choice: SyncHintChoice;
  onDismiss: (id: SyncHintId) => void;
  onOpenSettings: (focus: ClaudeImportKind) => void;
  /** Turns web sync on and starts the first sync; progress then shows on the sidebar status line. */
  onTurnOnWeb: () => void;
  onOpenExportHelp: () => void;
}

export function SyncHintsView({
  choice,
  onDismiss,
  onOpenSettings,
  onTurnOnWeb,
  onOpenExportHelp,
}: SyncHintsViewProps) {
  if (!choice) return null;
  const { options } = choice;
  const option = (
    testId: string,
    label: string,
    description: string,
    focus: ClaudeImportKind,
    onClick: () => void = () => onOpenSettings(focus)
  ) => (
    <Button
      size="sm"
      variant="plain"
      color="neutral"
      onClick={onClick}
      startDecorator={<img src={focus === 'b4m-web' ? bike4mindIcon : claudeIcon} alt="" width={22} height={22} />}
      endDecorator={<ArrowRightIcon />}
      sx={{
        justifyContent: 'flex-start',
        textAlign: 'left',
        px: 1,
        py: 1,
        gap: 1,
        borderRadius: 'sm',
        fontWeight: 500,
        '& .MuiButton-startDecorator': { color: 'text.tertiary' },
        '& .MuiButton-endDecorator': { ml: 'auto', color: 'text.tertiary' },
      }}
      data-testid={testId}
    >
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {description}
        </Typography>
      </Stack>
    </Button>
  );
  return (
    <HintCard
      testId="sidebar-empty-sync-card"
      heading="Bring your chats along"
      onClose={() => onDismiss('sidebar-empty')}
      closeLabel="Hide these suggestions"
    >
      <Stack spacing={0.25} sx={{ mx: -0.5 }}>
        {options.code && option('sidebar-empty-sync-code-btn', 'Claude Code', 'Sync local sessions', 'claude-code')}
        {options.chat && option('sidebar-empty-sync-chat-btn', 'Claude', 'Import a claude.ai export', 'claude-chat')}
        {options.web && (
          <Stack direction="row" sx={{ alignItems: 'center' }}>
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              {option('sidebar-empty-sync-web-btn', 'Bike4Mind web', 'Sync your web chats', 'b4m-web', onTurnOnWeb)}
            </Stack>
            <Link
              level="body-xs"
              color="neutral"
              component="button"
              onClick={() => onOpenSettings('b4m-web')}
              sx={{ flexShrink: 0, px: 1 }}
              data-testid="sidebar-empty-sync-web-settings-link"
            >
              Settings
            </Link>
          </Stack>
        )}
      </Stack>
      <Stack spacing={0.5} sx={{ pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography level="body-xs" textColor="text.tertiary">
          Imported chats stay on this device.
        </Typography>
        {options.chat && (
          <Link
            level="body-xs"
            color="neutral"
            component="button"
            onClick={onOpenExportHelp}
            sx={{ alignSelf: 'flex-start' }}
            data-testid="sidebar-empty-sync-export-help-link"
          >
            How to export from Claude
          </Link>
        )}
      </Stack>
    </HintCard>
  );
}

/**
 * The sidebar's sync hint, kept live from main; `fallback` shows when there is none. `showWebSync`
 * adds the Bike4Mind web sync status line above it (chat lists only: web notebooks import as chats).
 */
export function SidebarSyncHints({
  empty,
  fallback = null,
  showWebSync = false,
  onOpenSettings,
}: {
  empty: boolean;
  fallback?: ReactNode;
  showWebSync?: boolean;
  onOpenSettings: (focus: ClaudeImportKind) => void;
}) {
  const [state, setState] = useClaudeImport();
  const api = typeof window === 'undefined' ? undefined : window.b4m?.claudeImport;
  const choice = pickSyncHint(state, empty);
  const turnOnWeb = () => void api?.setWebSettings({ enabled: true }).then(setState, () => {});
  // The empty-sidebar card already offers web sync; a second "not synced" line would repeat it.
  const webStatus =
    api && showWebSync && !(choice?.options.web && state && !state.web.settings.enabled) ? (
      <WebSyncStatus state={state} onSyncNow={() => void api.syncWeb().then(setState, () => {})} onTurnOn={turnOnWeb} />
    ) : null;
  if (!api || !choice) {
    return (
      <>
        {webStatus}
        {fallback}
      </>
    );
  }

  return (
    <>
      {webStatus}
      <SyncHintsView
        choice={choice}
        onDismiss={id => void api.dismissHint(id).then(setState, () => {})}
        onOpenSettings={onOpenSettings}
        onTurnOnWeb={turnOnWeb}
        onOpenExportHelp={() => void window.b4m.shell.openExternal(CLAUDE_EXPORT_HELP_URL)}
      />
    </>
  );
}
