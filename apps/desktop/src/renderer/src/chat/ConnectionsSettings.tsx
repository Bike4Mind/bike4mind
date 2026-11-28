import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { HostEntry, SshAliasDescription } from '@shared/hostConnection';
import { useHostEntries } from '../host/hostRegistry';
import { accountLine, hostStatusView } from '../host/hostPresentation';
import { useHostOperation } from '../host/hostOperations';
import { useDesktopVersion } from '../host/useDesktopVersion';
import { useSshAliases } from '../host/useSshAliases';
import { HostActions } from './HostActions';
import { HostErrorDetail, HostOperationNotice, HostStatusDot } from './HostStatus';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const remoteHosts = (entries: readonly HostEntry[]): HostEntry[] => entries.filter(entry => entry.kind === 'remote');

export function connectionsSummary(entries: readonly HostEntry[]): string {
  const remote = remoteHosts(entries);
  if (remote.length === 0) return 'No remote hosts. Turn one on from your SSH config.';
  const connected = remote.filter(entry => entry.state.status === 'connected').length;
  return `${remote.length} ${remote.length === 1 ? 'host' : 'hosts'}, ${connected} connected`;
}

/** One word for the nav row when a host needs the user; nothing when all is well. */
export function connectionsAttention(entries: readonly HostEntry[]): string | undefined {
  const remote = remoteHosts(entries);
  if (remote.some(entry => entry.state.status === 'needsSignIn')) return 'Sign in';
  if (remote.some(entry => entry.state.status === 'failed' || entry.state.status === 'accountMismatch'))
    return 'Failed';
  return undefined;
}

/** What `ssh -G` resolves an alias to; absent while it loads or when ssh cannot say. */
function useAliasDescription(alias: string | null): SshAliasDescription | null {
  const [description, setDescription] = useState<SshAliasDescription | null>(null);
  useEffect(() => {
    if (!alias) return;
    let live = true;
    window.b4m.host
      .describeSshAlias(alias)
      .then(next => live && setDescription(next))
      .catch((failure: unknown) => console.warn(`Could not resolve the SSH alias ${alias}`, failure));
    return () => {
      live = false;
    };
  }, [alias]);
  return description;
}

function Endpoint({ alias }: { alias: string | null }) {
  const description = useAliasDescription(alias);
  if (!description) return null;
  const port = description.port === 22 ? '' : `:${description.port}`;
  return (
    <Typography level="body-xs" textColor="text.tertiary" data-testid="connections-host-endpoint">
      {description.user}@{description.hostname}
      {port}
    </Typography>
  );
}

function HostRow({ entry, alias }: { entry: HostEntry; alias: string | null }) {
  const desktopVersion = useDesktopVersion();
  const operation = useHostOperation(entry.hostId);
  const view = hostStatusView(entry.state, desktopVersion, Date.now());
  const { state } = entry;
  const installing = operation.status === 'running';
  const statusLabel = installing ? (operation.kind === 'install' ? 'Installing' : 'Updating') : view.label;
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25 }}
      data-testid="connections-host"
      data-host-id={entry.hostId}
      data-status={state.status}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <HostStatusDot tone={installing ? 'primary' : view.tone} label={statusLabel} testId="connections-host-dot" />
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm" noWrap data-testid="connections-host-name">
              {entry.label}
            </Typography>
            <Endpoint alias={alias} />
          </Stack>
          <Chip
            size="sm"
            variant="soft"
            color={installing ? 'primary' : view.tone}
            data-testid="connections-host-status"
          >
            {statusLabel}
          </Chip>
        </Stack>
        {state.status === 'connected' && (
          <Typography level="body-xs" textColor="text.secondary" data-testid="connections-host-version">
            Host version {state.info.hostVersion}. {accountLine(state.info.account)}.
          </Typography>
        )}
        {view.detail && !installing && state.status !== 'failed' && (
          <Typography level="body-xs" textColor="text.secondary" data-testid="connections-host-detail">
            {view.detail}
          </Typography>
        )}
        {state.status === 'failed' && (
          <HostErrorDetail failure={state.failure} alias={alias} testId="connections-host-failure" />
        )}
        <HostOperationNotice operation={operation} alias={alias} testId="connections-host-operation" />
        <HostActions entry={entry} testIdPrefix="connections-action" />
      </Stack>
    </Sheet>
  );
}

function AliasRow({ alias }: { alias: string }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await window.b4m.host.addSshHost(alias);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setAdding(false);
    }
  };
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25 }}
      data-testid="connections-alias"
      data-alias={alias}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap>
            {alias}
          </Typography>
          <Endpoint alias={alias} />
        </Stack>
        <Chip size="sm" variant="soft" color="neutral">
          In your SSH config
        </Chip>
        <Button size="sm" loading={adding} onClick={() => void add()} data-testid="connections-alias-add-btn">
          Add
        </Button>
      </Stack>
      {error && (
        <Alert color="danger" size="sm" sx={{ mt: 1 }} data-testid="connections-alias-error">
          {error}
        </Alert>
      )}
    </Sheet>
  );
}

/**
 * Remote machines: the hosts Desktop knows, then the aliases of `~/.ssh/config` not added yet.
 * Connection state is main's, mirrored by the host registry; this page only shows it and offers
 * the actions each state allows.
 */
export function ConnectionsSettings() {
  const entries = useHostEntries();
  const { aliases, error } = useSshAliases(entries);
  const hosts = useMemo(() => remoteHosts(entries), [entries]);
  const unadded = (aliases ?? []).filter(entry => entry.hostId === null);
  const aliasOf = (entry: HostEntry): string | null =>
    (aliases ?? []).find(candidate => candidate.hostId === entry.hostId)?.alias ?? null;

  return (
    <Stack spacing={1} data-testid="connections-settings">
      {error && (
        <Alert color="danger" size="sm" data-testid="connections-aliases-error">
          {error}
        </Alert>
      )}
      {hosts.map(entry => (
        <HostRow key={entry.hostId} entry={entry} alias={aliasOf(entry)} />
      ))}
      {unadded.map(entry => (
        <AliasRow key={entry.alias} alias={entry.alias} />
      ))}
      {hosts.length === 0 && unadded.length === 0 && aliases !== null && (
        <Typography level="body-sm" textColor="text.secondary" data-testid="connections-empty">
          No hosts found. Add a Host entry to ~/.ssh/config and it appears here. Desktop connects with your SSH keys or
          agent and never asks for a password.
        </Typography>
      )}
    </Stack>
  );
}
