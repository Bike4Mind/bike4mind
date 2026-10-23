import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Divider from '@mui/joy/Divider';
import Link from '@mui/joy/Link';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import {
  CLAUDE_EXPORT_HELP_URL,
  type ClaudeImportKind,
  type ClaudeImportState,
  type ClaudeRemoveResult,
} from '@shared/claudeImport';
import { useImportedInline } from './importedInline';

/** Absent when rendered without the preload bridge, as the server-rendered tests do. */
function claudeImportApi() {
  return typeof window === 'undefined' ? undefined : window.b4m?.claudeImport;
}

/** The import state, kept current from main's pushes; null until the first read lands. */
export function useClaudeImport(): [
  ClaudeImportState | null,
  (state: ClaudeImportState) => void,
  string | null,
  () => void,
] {
  const [state, setState] = useState<ClaudeImportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const api = claudeImportApi();
    if (!api) return undefined;
    let live = true;
    let receivedPush = false;
    setError(null);
    const load = async () => {
      try {
        const next = await api.getState();
        if (live && !receivedPush) setState(next);
      } catch (error) {
        if (live && !receivedPush) setError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const off = api.onStateChanged(next => {
      receivedPush = true;
      setState(next);
      setError(null);
    });
    return () => {
      live = false;
      off();
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt(previous => previous + 1), []);
  return [state, setState, error, retry];
}

export function claudeImportSummary(state: ClaudeImportState | null): string {
  if (!state) return 'Loading...';
  if (!state.signedIn) return 'Sign in to import';
  const code = state.code.settings.enabled
    ? `Claude Code sync on, ${state.code.counts.imported} imported`
    : 'Claude Code sync off';
  const chats = state.chat.lastImport ? `, ${state.chat.lastImport.counts.found} chats in last export` : '';
  return `${code}${chats}`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <Stack sx={{ minWidth: 64 }}>
      <Typography level="title-sm" data-testid={testId}>
        {value}
      </Typography>
      <Typography level="body-xs" textColor="text.tertiary">
        {label}
      </Typography>
    </Stack>
  );
}

const KIND_LABEL: Record<ClaudeImportKind, string> = { 'claude-code': 'Claude Code', 'claude-chat': 'Claude chat' };

/**
 * Settings > Import from Claude. Every path is picked in a native dialog in main; this screen
 * only ever names what to do, never which file to read.
 */
export function ClaudeImportSettings({
  state,
  onState,
  loadError,
  onRetry,
}: {
  state: ClaudeImportState | null;
  onState: (state: ClaudeImportState) => void;
  loadError: string | null;
  onRetry: () => void;
}) {
  const api = claudeImportApi();
  const [inline, setInline] = useImportedInline();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<ClaudeImportKind | null>(null);
  const [removing, setRemoving] = useState(false);

  // Opening Settings re-scans, so the counts describe the folder as it is now. Once only:
  // switching sync on starts its own pass in main.
  const scanned = useRef(false);
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded || scanned.current) return;
    scanned.current = true;
    if (state?.code.settings.enabled) api?.syncCode().catch(() => undefined);
  }, [api, loaded, state]);

  const run = useCallback(
    async (work: () => Promise<ClaudeImportState>) => {
      setMessage(null);
      try {
        onState(await work());
      } catch (error) {
        setMessage({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
      }
    },
    [onState]
  );
  // Two quick clicks would each build on the selection drawn before either reply arrived.
  const pendingProjects = useRef<{ selection: Set<string>; inFlight: number } | null>(null);

  if (loadError) {
    return (
      <Alert
        color="danger"
        variant="soft"
        data-testid="claude-import-load-error"
        endDecorator={
          <Button size="sm" color="danger" variant="soft" onClick={onRetry} data-testid="claude-import-retry-btn">
            Retry
          </Button>
        }
      >
        Could not load import settings. {loadError}
      </Alert>
    );
  }

  if (!api || !state) {
    return (
      <Typography level="body-sm" data-testid="claude-import-loading">
        Loading...
      </Typography>
    );
  }

  const { code, chat } = state;
  const enabled = code.settings.enabled;
  const projects = code.settings.projects;
  const selected = new Set(projects === 'all' ? [] : projects);

  const remove = async (kind: ClaudeImportKind) => {
    setRemoving(true);
    try {
      const result: ClaudeRemoveResult = await api.remove(kind);
      const kept = result.keptForked > 0 ? ` ${result.keptForked} you continued here were kept.` : '';
      setMessage({ tone: 'success', text: `Removed ${result.removed} imported ${KIND_LABEL[kind]} sessions.${kept}` });
      onState(await api.getState());
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setRemoving(false);
      setConfirming(null);
    }
  };

  return (
    <Stack spacing={2} data-testid="claude-import-settings">
      <Typography level="body-xs" textColor="text.tertiary" data-testid="claude-import-privacy-text">
        Imported conversations stay on this computer. Their content is sent to the Bike4Mind server and model only if
        you continue one of them here. Claude&apos;s own files are only ever read, never changed.
      </Typography>

      {!state.signedIn && (
        <Alert color="neutral" variant="soft" data-testid="claude-import-signed-out-alert">
          Sign in first: imported sessions are saved with your account&apos;s other conversations on this computer.
        </Alert>
      )}

      {message && (
        <Alert color={message.tone} variant="soft" data-testid="claude-import-message-alert">
          {message.text}
        </Alert>
      )}

      <Stack spacing={1.25} data-testid="claude-import-code-section">
        <Typography level="title-sm">Claude Code sessions</Typography>
        <Switch
          size="sm"
          checked={enabled}
          disabled={!state.signedIn}
          onChange={event => void run(() => api.setCodeSettings({ enabled: event.target.checked }))}
          endDecorator="Keep in sync"
          sx={{ alignSelf: 'flex-start' }}
          slotProps={{
            input: {
              'aria-label': 'Keep Claude Code sessions in sync',
              'data-testid': 'claude-import-code-enable-switch',
            },
          }}
        />
        <Typography level="body-xs" textColor="text.tertiary">
          Sessions Claude Code ran in its own worktrees (a project&apos;s .claude/worktrees folder), filed under that
          project. Sessions run anywhere else, including other tools&apos; worktrees, are left out. A session you
          continue here becomes your own copy and stops syncing, so nothing you add is ever overwritten.
        </Typography>

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography
            level="body-xs"
            sx={{ fontFamily: 'code', wordBreak: 'break-all' }}
            data-testid="claude-import-code-folder-text"
          >
            {code.sourceFolder}
          </Typography>
          <Button
            size="sm"
            variant="plain"
            onClick={() => void run(() => api.pickCodeFolder(false))}
            data-testid="claude-import-code-folder-btn"
          >
            Change...
          </Button>
          {code.settings.sourceFolder && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => void run(() => api.pickCodeFolder(true))}
              data-testid="claude-import-code-folder-reset-btn"
            >
              Use default
            </Button>
          )}
        </Stack>

        <Checkbox
          size="sm"
          label="Include subagent sessions"
          checked={code.settings.includeSubagents}
          onChange={event => void run(() => api.setCodeSettings({ includeSubagents: event.target.checked }))}
          slotProps={{ input: { 'data-testid': 'claude-import-code-subagents-checkbox' } }}
        />

        <RadioGroup
          size="sm"
          orientation="horizontal"
          value={projects === 'all' ? 'all' : 'pick'}
          onChange={event =>
            void run(() => api.setCodeSettings({ projects: event.target.value === 'all' ? 'all' : [...selected] }))
          }
          data-testid="claude-import-code-projects-group"
        >
          <Radio
            value="all"
            label="All projects"
            slotProps={{ input: { 'data-testid': 'claude-import-code-projects-all-radio' } }}
          />
          <Radio
            value="pick"
            label="Only these projects"
            slotProps={{ input: { 'data-testid': 'claude-import-code-projects-pick-radio' } }}
          />
        </RadioGroup>
        {projects !== 'all' && (
          <Sheet
            variant="soft"
            sx={{ borderRadius: 'sm', p: 1, maxHeight: 220, overflowY: 'auto' }}
            data-testid="claude-import-code-projects-list"
          >
            {code.projects.length === 0 && (
              <Typography level="body-xs" textColor="text.tertiary">
                No projects found yet. Sync to look for some.
              </Typography>
            )}
            <Stack spacing={0.5}>
              {code.projects.map(project => (
                <Checkbox
                  key={project.cwd}
                  size="sm"
                  checked={selected.has(project.cwd)}
                  label={`${project.name} (${project.sessions})`}
                  title={project.cwd}
                  onChange={event => {
                    const pending = pendingProjects.current ?? { selection: selected, inFlight: 0 };
                    const next = new Set(pending.selection);
                    if (event.target.checked) next.add(project.cwd);
                    else next.delete(project.cwd);
                    pendingProjects.current = { selection: next, inFlight: pending.inFlight + 1 };
                    void run(() => api.setCodeSettings({ projects: [...next] })).finally(() => {
                      const current = pendingProjects.current;
                      if (current && --current.inFlight === 0) pendingProjects.current = null;
                    });
                  }}
                  slotProps={{ input: { 'data-testid': 'claude-import-code-project-checkbox' } }}
                />
              ))}
            </Stack>
          </Sheet>
        )}

        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }} data-testid="claude-import-code-counts">
          <Count label="found" value={code.counts.found} testId="claude-import-code-found-text" />
          <Count label="imported" value={code.counts.imported} testId="claude-import-code-imported-text" />
          <Count label="skipped" value={code.counts.skipped} testId="claude-import-code-skipped-text" />
          <Count label="failed" value={code.counts.failed} testId="claude-import-code-failed-text" />
          <Count label="continued here" value={code.forked} testId="claude-import-code-forked-text" />
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button
            size="sm"
            variant="outlined"
            loading={code.running}
            disabled={!state.signedIn}
            onClick={() => void run(() => api.syncCode())}
            data-testid="claude-import-code-sync-btn"
          >
            Sync now
          </Button>
          <Typography level="body-xs" textColor="text.tertiary" data-testid="claude-import-code-last-sync-text">
            Last sync: {when(code.lastSyncAt)}
            {code.lastSyncMs !== null ? ` (${(code.lastSyncMs / 1000).toFixed(1)}s)` : ''}
          </Typography>
        </Stack>
        {code.error && (
          <Typography level="body-xs" color="danger" data-testid="claude-import-code-error-text">
            {code.error}
          </Typography>
        )}
      </Stack>

      <Divider />

      <Stack spacing={1.25} data-testid="claude-import-chat-section">
        <Typography level="title-sm">Claude chats</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          claude.ai has no way for other apps to read your chats, so they come from your data export: in claude.ai open
          Settings, then Privacy, then Export data, and pick the .zip it emails you (or the conversations.json inside
          it). Importing a newer export updates the chats that changed.{' '}
          <Link
            level="body-xs"
            component="button"
            onClick={() => void window.b4m.shell.openExternal(CLAUDE_EXPORT_HELP_URL)}
            data-testid="claude-import-chat-help-link"
          >
            How to export your data
          </Link>
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button
            size="sm"
            variant="outlined"
            loading={chat.running}
            disabled={!state.signedIn}
            onClick={() =>
              void run(async () => {
                const result = await api.importChatExport();
                if (!result.ok) throw new Error(result.error);
                return result.state;
              })
            }
            data-testid="claude-import-chat-import-btn"
          >
            Import export...
          </Button>
        </Stack>
        {chat.lastImport && (
          <Typography level="body-xs" data-testid="claude-import-chat-summary-text">
            {chat.lastImport.fileName} on {when(chat.lastImport.at)}: {chat.lastImport.counts.found} found,{' '}
            {chat.lastImport.counts.imported} new, {chat.lastImport.counts.updated} updated,{' '}
            {chat.lastImport.counts.unchanged} unchanged, {chat.lastImport.counts.skipped} skipped,{' '}
            {chat.lastImport.counts.failed} failed
            {chat.lastImport.error ? `. Stopped: ${chat.lastImport.error}` : ''}
          </Typography>
        )}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography level="body-xs" textColor="text.tertiary">
            {chat.watchFolder
              ? 'Importing new exports saved to'
              : 'Optionally, import new exports as they arrive in a folder.'}
          </Typography>
          {chat.watchFolder && (
            <Typography
              level="body-xs"
              sx={{ fontFamily: 'code', wordBreak: 'break-all' }}
              data-testid="claude-import-chat-watch-text"
            >
              {chat.watchFolder}
            </Typography>
          )}
          <Button
            size="sm"
            variant="plain"
            disabled={!state.signedIn}
            onClick={() => void run(() => api.setWatchFolder(false))}
            data-testid="claude-import-chat-watch-btn"
          >
            {chat.watchFolder ? 'Change...' : 'Watch a folder...'}
          </Button>
          {chat.watchFolder && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => void run(() => api.setWatchFolder(true))}
              data-testid="claude-import-chat-unwatch-btn"
            >
              Stop watching
            </Button>
          )}
        </Stack>
      </Stack>

      <Divider />

      <Stack spacing={1.25}>
        <Switch
          size="sm"
          checked={inline}
          onChange={event => setInline(event.target.checked)}
          endDecorator="Show imported sessions in their project groups"
          sx={{ alignSelf: 'flex-start' }}
          slotProps={{ input: { 'data-testid': 'claude-import-inline-switch' } }}
        />
        <Typography level="body-xs" textColor="text.tertiary">
          Off collects them in their own &quot;Imported from Claude&quot; section of the sidebar instead.
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="sm"
            variant="plain"
            color="danger"
            disabled={!state.signedIn}
            onClick={() => setConfirming('claude-code')}
            data-testid="claude-import-code-remove-btn"
          >
            Remove imported Claude Code sessions
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="danger"
            disabled={!state.signedIn}
            onClick={() => setConfirming('claude-chat')}
            data-testid="claude-import-chat-remove-btn"
          >
            Remove imported Claude chats
          </Button>
        </Stack>
      </Stack>

      <Modal open={confirming !== null} onClose={() => !removing && setConfirming(null)}>
        <ModalDialog size="sm" role="alertdialog" data-testid="claude-import-remove-dialog">
          <DialogTitle>Remove imported {confirming ? KIND_LABEL[confirming] : ''} sessions?</DialogTitle>
          <DialogContent>
            This deletes this app&apos;s copies only. Your files in Claude are not touched, and sessions you continued
            here are kept.{confirming === 'claude-code' ? ' Sync is turned off so they are not imported again.' : ''}
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              loading={removing}
              onClick={() => confirming && void remove(confirming)}
              data-testid="claude-import-remove-confirm-btn"
            >
              Remove
            </Button>
            <Button
              variant="plain"
              color="neutral"
              disabled={removing}
              onClick={() => setConfirming(null)}
              data-testid="claude-import-remove-cancel-btn"
            >
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
}
