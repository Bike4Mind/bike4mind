import { useId, useState, type ReactNode } from 'react';
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
import { CloseIcon } from './icons';

export interface EmptyCardOptions {
  code: boolean;
  chat: boolean;
  web: boolean;
}

export type SyncHintChoice =
  | { kind: 'sidebar-empty'; options: EmptyCardOptions }
  | { kind: 'claude-code'; count: number }
  | { kind: 'web'; count: number }
  | null;

/**
 * The one sync hint the sidebar shows, if any. Only for a signed-in account, never for a sync
 * that is on or has nothing to bring in, never once closed; the empty-sidebar card comes first.
 */
export function pickSyncHint(state: ClaudeImportState | null, empty: boolean): SyncHintChoice {
  if (!state?.signedIn) return null;
  const { dismissed, codeSessions, webNotebooks } = state.hints;
  const open = (id: SyncHintId) => !dismissed.includes(id);
  const code = !state.code.settings.enabled && (codeSessions ?? 0) > 0;
  const web = !state.web.settings.enabled && (webNotebooks ?? 0) > 0;
  if (empty && open('sidebar-empty')) return { kind: 'sidebar-empty', options: { code, chat: true, web } };
  if (code && open('claude-code')) return { kind: 'claude-code', count: codeSessions ?? 0 };
  if (web && open('web')) return { kind: 'web', count: webNotebooks ?? 0 };
  return null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function HintCard({
  testId,
  heading,
  headingProps,
  children,
  onClose,
  closeLabel,
}: {
  testId: string;
  heading: string;
  headingProps?: { fontWeight: 'md' };
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
}) {
  const headingId = useId();
  return (
    <Sheet
      variant="soft"
      role="region"
      aria-labelledby={headingId}
      data-testid={testId}
      sx={{ mx: 1, mb: 1, py: 1, pl: 1.25, pr: 0.5, borderRadius: 'sm' }}
    >
      <Stack direction="row" alignItems="flex-start" sx={{ position: 'relative' }}>
        <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={headingId} level="body-xs" sx={{ pr: 4 }} {...headingProps}>
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
          sx={{ position: 'absolute', top: 0, right: 0 }}
        >
          <CloseIcon />
        </IconButton>
      </Stack>
    </Sheet>
  );
}

function SourceHint({
  testId,
  text,
  error,
  onEnable,
  onDismiss,
}: {
  testId: string;
  text: string;
  error?: boolean;
  onEnable: () => void;
  onDismiss: () => void;
}) {
  return (
    <HintCard testId={testId} heading={text} onClose={onDismiss} closeLabel="Hide this hint">
      {error && (
        <Typography level="body-xs" color="danger" data-testid={`${testId}-error`}>
          Could not turn on sync. Try again.
        </Typography>
      )}
      <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Button
          size="sm"
          variant="soft"
          onClick={onEnable}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0, minHeight: 24, fontSize: 12, fontWeight: 500, px: 1 }}
          data-testid={`${testId}-enable-btn`}
        >
          Turn on sync
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onDismiss}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0, minHeight: 24, fontSize: 12, fontWeight: 500, px: 1 }}
          data-testid={`${testId}-dismiss-btn`}
        >
          Not now
        </Button>
      </Stack>
    </HintCard>
  );
}

export interface SyncHintsViewProps {
  choice: SyncHintChoice;
  enableFailed?: boolean;
  onDismiss: (id: SyncHintId) => void;
  onEnable: (source: 'claude-code' | 'web') => void;
  onOpenSettings: (focus: ClaudeImportKind) => void;
  onOpenExportHelp: () => void;
}

export function SyncHintsView({
  choice,
  enableFailed,
  onDismiss,
  onEnable,
  onOpenSettings,
  onOpenExportHelp,
}: SyncHintsViewProps) {
  if (!choice) return null;
  if (choice.kind === 'claude-code') {
    return (
      <SourceHint
        testId="sync-hint-claude-code"
        text={`Found ${plural(choice.count, 'Claude Code session', 'Claude Code sessions')}. Sync them here?`}
        error={enableFailed}
        onEnable={() => onEnable('claude-code')}
        onDismiss={() => onDismiss('claude-code')}
      />
    );
  }
  if (choice.kind === 'web') {
    return (
      <SourceHint
        testId="sync-hint-web"
        text={`You have ${plural(choice.count, 'chat', 'chats')} on Bike4Mind web. Show them here?`}
        error={enableFailed}
        onEnable={() => onEnable('web')}
        onDismiss={() => onDismiss('web')}
      />
    );
  }
  const { options } = choice;
  const option = (testId: string, label: string, focus: ClaudeImportKind) => (
    <Button
      size="sm"
      variant="outlined"
      color="neutral"
      onClick={() => onOpenSettings(focus)}
      sx={{ justifyContent: 'flex-start' }}
      data-testid={testId}
    >
      {label}
    </Button>
  );
  return (
    <HintCard
      testId="sidebar-empty-sync-card"
      heading="No conversations yet. Bring some in:"
      headingProps={{ fontWeight: 'md' }}
      onClose={() => onDismiss('sidebar-empty')}
      closeLabel="Hide these suggestions"
    >
      {options.code && option('sidebar-empty-sync-code-btn', 'Bring in your Claude Code sessions', 'claude-code')}
      {options.chat && (
        <Stack spacing={0.25}>
          {option('sidebar-empty-sync-chat-btn', 'Import your claude.ai chats', 'claude-chat')}
          <Link
            level="body-xs"
            component="button"
            onClick={onOpenExportHelp}
            sx={{ alignSelf: 'flex-start' }}
            data-testid="sidebar-empty-sync-export-help-link"
          >
            How to export them
          </Link>
        </Stack>
      )}
      {options.web && option('sidebar-empty-sync-web-btn', 'Sync your Bike4Mind web chats', 'b4m-web')}
    </HintCard>
  );
}

/** The sidebar's sync hint, kept live from main; `fallback` shows when there is none. */
export function SidebarSyncHints({
  empty,
  fallback = null,
  onOpenSettings,
}: {
  empty: boolean;
  fallback?: ReactNode;
  onOpenSettings: (focus: ClaudeImportKind) => void;
}) {
  const [state, setState] = useClaudeImport();
  const api = typeof window === 'undefined' ? undefined : window.b4m?.claudeImport;
  const [failedEnable, setFailedEnable] = useState<'claude-code' | 'web' | null>(null);
  const choice = pickSyncHint(state, empty);
  if (!api || !choice) return <>{fallback}</>;

  const update = (work: () => Promise<ClaudeImportState>, onFail: () => void = () => {}) => {
    setFailedEnable(null);
    void work().then(setState, onFail);
  };
  return (
    <>
      {choice.kind !== 'sidebar-empty' && fallback}
      <SyncHintsView
        choice={choice}
        enableFailed={failedEnable === choice.kind}
        onDismiss={id => update(() => api.dismissHint(id))}
        onEnable={source =>
          update(
            async () => {
              if (source === 'claude-code') await api.setCodeSettings({ enabled: true });
              else await api.setWebSettings({ enabled: true });
              return api.dismissHint(source);
            },
            () => setFailedEnable(source)
          )
        }
        onOpenSettings={onOpenSettings}
        onOpenExportHelp={() => void window.b4m.shell.openExternal(CLAUDE_EXPORT_HELP_URL)}
      />
    </>
  );
}
