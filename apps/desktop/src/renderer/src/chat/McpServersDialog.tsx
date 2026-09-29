import { useCallback, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogTitle from '@mui/joy/DialogTitle';
import Divider from '@mui/joy/Divider';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { McpServerInput, McpServerState, McpServerStatus, McpTransport } from '@shared/mcp';
import { ChevronIcon, PlusIcon, ServerIcon } from './icons';
import type { McpServersController } from './useMcpServers';

type StatusLook = { color: 'success' | 'danger' | 'neutral' | 'warning'; label: string };

const STATUS_LOOK: Record<McpServerStatus, StatusLook> = {
  connected: { color: 'success', label: 'Connected' },
  connecting: { color: 'warning', label: 'Connecting' },
  failed: { color: 'danger', label: 'Failed' },
  idle: { color: 'neutral', label: 'Not connected' },
  disabled: { color: 'neutral', label: 'Off' },
};

/** `a b "c d"` -> ['a', 'b', 'c d']. Quoting is the only way to pass an argument with a space. */
function splitArgs(raw: string): string[] {
  return (raw.match(/"[^"]*"|\S+/g) ?? []).map(part => part.replace(/^"|"$/g, '')).filter(part => part.length > 0);
}

function joinArgs(args: readonly string[] | undefined): string {
  return (args ?? []).map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}

/** `KEY=value` per line, which is how every other tool that takes these spells them. */
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

interface Draft {
  id: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  secrets: string;
}

function emptyDraft(): Draft {
  return { id: null, name: '', transport: 'stdio', command: '', args: '', url: '', secrets: '' };
}

function draftFor(server: McpServerState): Draft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: joinArgs(server.args),
    url: server.url ?? '',
    secrets: '',
  };
}

/**
 * What an MCP server is doing, in the one place a user can act on it.
 *
 * The status chip and the tool count are the whole reason this list exists: a server that
 * failed to start and one that started and declared nothing both contribute no tools, and
 * without a state to read they are the same empty row. The error and the child's last stderr
 * lines are shown with it, because for a stdio server that IS the explanation.
 */
function ServerRow({
  server,
  controller,
  onEdit,
}: {
  server: McpServerState;
  controller: McpServersController;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const look = STATUS_LOOK[server.status];

  return (
    <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'sm' }} data-testid="mcp-server-row">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Box sx={{ color: 'text.tertiary', display: 'flex' }}>
          <ServerIcon />
        </Box>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap>
            {server.name}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {server.transport === 'stdio' ? `${server.command ?? ''} ${joinArgs(server.args)}`.trim() : server.url}
          </Typography>
        </Stack>

        {server.status === 'connecting' && <CircularProgress size="sm" data-testid="mcp-server-connecting" />}
        <Chip size="sm" variant="soft" color={look.color} data-testid="mcp-server-status">
          {look.label}
        </Chip>
        <Chip size="sm" variant="outlined" color="neutral" data-testid="mcp-server-tool-count">
          {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
        </Chip>
        <Switch
          size="sm"
          checked={server.enabled}
          onChange={event => void controller.setEnabled(server.id, event.target.checked)}
          slotProps={{ input: { 'aria-label': `Enable ${server.name}`, 'data-testid': 'mcp-server-enable-switch' } }}
        />
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={open ? 'Hide details' : 'Show details'}
          onClick={() => setOpen(current => !current)}
          data-testid="mcp-server-expand-btn"
        >
          <ChevronIcon open={open} />
        </IconButton>
      </Stack>

      {server.status === 'failed' && server.error && (
        <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="mcp-server-error">
          {server.error}
        </Alert>
      )}

      {open && (
        <Stack spacing={1} sx={{ mt: 1.25 }} data-testid="mcp-server-details">
          {server.tools.length > 0 && (
            <Box>
              <Typography level="body-xs" sx={{ fontWeight: 'lg', mb: 0.5 }}>
                Tools it contributed
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {server.tools.map(tool => (
                  <Chip key={tool.name} size="sm" variant="soft" color="primary" data-testid="mcp-server-tool-chip">
                    {tool.remoteName}
                  </Chip>
                ))}
              </Stack>
            </Box>
          )}

          {(server.envKeys.length > 0 || server.headerKeys.length > 0) && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="mcp-server-secret-keys">
              {server.transport === 'stdio' ? 'Environment' : 'Headers'}:{' '}
              {(server.transport === 'stdio' ? server.envKeys : server.headerKeys).join(', ')} (values are kept in the
              OS keychain and are never shown again)
            </Typography>
          )}

          {server.stderr && (
            <Box>
              <Typography level="body-xs" sx={{ fontWeight: 'lg', mb: 0.5 }}>
                Server output
              </Typography>
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                component="pre"
                sx={{ m: 0, whiteSpace: 'pre-wrap', fontFamily: 'code', maxHeight: 140, overflow: 'auto' }}
                data-testid="mcp-server-stderr"
              >
                {server.stderr}
              </Typography>
            </Box>
          )}

          <Stack direction="row" spacing={1}>
            <Button
              size="sm"
              variant="soft"
              color="neutral"
              onClick={() => void controller.reconnect(server.id)}
              data-testid="mcp-server-reconnect-btn"
            >
              Reconnect
            </Button>
            <Button size="sm" variant="soft" color="neutral" onClick={onEdit} data-testid="mcp-server-edit-btn">
              Edit
            </Button>
            <Button
              size="sm"
              variant="soft"
              color="danger"
              onClick={() => void controller.remove(server.id)}
              data-testid="mcp-server-remove-btn"
            >
              Remove
            </Button>
          </Stack>
        </Stack>
      )}
    </Sheet>
  );
}

function ServerForm({
  draft,
  setDraft,
  error,
  busy,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const stdio = draft.transport === 'stdio';

  return (
    <Stack spacing={1.25} data-testid="mcp-server-form">
      <FormControl size="sm">
        <FormLabel>Name</FormLabel>
        <Input
          value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          placeholder="github"
          slotProps={{ input: { 'data-testid': 'mcp-form-name-input' } }}
        />
        <FormHelperText>
          Its tools appear to the model as mcp__{'{name}'}__{'{tool}'}.
        </FormHelperText>
      </FormControl>

      <FormControl size="sm">
        <FormLabel>Transport</FormLabel>
        <Select
          value={draft.transport}
          onChange={(_event, value) => setDraft({ ...draft, transport: (value ?? 'stdio') as McpTransport })}
          slotProps={{ button: { 'data-testid': 'mcp-form-transport-select' } }}
        >
          <Option value="stdio">Local command (stdio)</Option>
          <Option value="http">Remote URL (HTTP)</Option>
        </Select>
      </FormControl>

      {stdio ? (
        <>
          <FormControl size="sm">
            <FormLabel>Command</FormLabel>
            <Input
              value={draft.command}
              onChange={event => setDraft({ ...draft, command: event.target.value })}
              placeholder="npx"
              slotProps={{ input: { 'data-testid': 'mcp-form-command-input' } }}
            />
            <FormHelperText>Use a full path if it is not on this app PATH.</FormHelperText>
          </FormControl>
          <FormControl size="sm">
            <FormLabel>Arguments</FormLabel>
            <Input
              value={draft.args}
              onChange={event => setDraft({ ...draft, args: event.target.value })}
              placeholder="-y @modelcontextprotocol/server-everything"
              slotProps={{ input: { 'data-testid': 'mcp-form-args-input' } }}
            />
            <FormHelperText>Separated by spaces; quote one that contains a space.</FormHelperText>
          </FormControl>
        </>
      ) : (
        <FormControl size="sm">
          <FormLabel>URL</FormLabel>
          <Input
            value={draft.url}
            onChange={event => setDraft({ ...draft, url: event.target.value })}
            placeholder="https://example.com/mcp"
            slotProps={{ input: { 'data-testid': 'mcp-form-url-input' } }}
          />
        </FormControl>
      )}

      <FormControl size="sm">
        <FormLabel>{stdio ? 'Environment variables' : 'Headers'}</FormLabel>
        <Input
          value={draft.secrets}
          onChange={event => setDraft({ ...draft, secrets: event.target.value })}
          placeholder={stdio ? 'GITHUB_TOKEN=ghp_...' : 'Authorization=Bearer ...'}
          slotProps={{ input: { 'data-testid': 'mcp-form-secrets-input' } }}
        />
        <FormHelperText>
          One KEY=value per entry. Stored in the OS keychain and never shown again
          {draft.id ? '; leave this empty to keep what is already saved.' : '.'}
        </FormHelperText>
      </FormControl>

      {error && (
        <Alert size="sm" color="danger" variant="soft" data-testid="mcp-form-error">
          {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1}>
        <Button size="sm" loading={busy} onClick={onSave} data-testid="mcp-form-save-btn">
          {draft.id ? 'Save' : 'Add server'}
        </Button>
        <Button size="sm" variant="plain" color="neutral" onClick={onCancel} data-testid="mcp-form-cancel-btn">
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * Add, inspect and remove MCP servers.
 *
 * Every tool one of these contributes runs through the same approval prompt a bash command
 * does, which the copy at the bottom says out loud: a user adding a server is adding a program
 * that can declare arbitrary tools inside an app that already reaches their filesystem, and
 * that is worth one sentence where they are making the decision.
 */
export function McpServersDialog({
  open,
  onClose,
  controller,
}: {
  open: boolean;
  onClose: () => void;
  controller: McpServersController;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const secrets = parsePairs(draft.secrets);
      const hasSecrets = Object.keys(secrets).length > 0;
      const input: McpServerInput = {
        name: draft.name,
        transport: draft.transport,
        ...(draft.transport === 'stdio'
          ? { command: draft.command, args: splitArgs(draft.args), ...(hasSecrets ? { env: secrets } : {}) }
          : { url: draft.url, ...(hasSecrets ? { headers: secrets } : {}) }),
      };
      // An empty secrets box on an EDIT means "keep what is stored", which is the only thing it
      // can mean: the values were never sent here to be re-typed.
      const failure = draft.id ? await controller.update(draft.id, input) : await controller.add(input);
      if (failure) setError(failure);
      else setDraft(null);
    } finally {
      setBusy(false);
    }
  }, [draft, controller]);

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 620, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' }} data-testid="mcp-dialog">
        <ModalClose data-testid="mcp-dialog-close-btn" />
        <DialogTitle>MCP servers</DialogTitle>

        <Stack spacing={1.25}>
          {!controller.secretsPersisted && (
            <Alert size="sm" color="warning" variant="soft" data-testid="mcp-dialog-no-keychain">
              This machine has no keychain this app can use, so tokens you enter are kept only until you quit. They are
              never written to disk in plain text.
            </Alert>
          )}

          {controller.servers.length === 0 && !draft && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="mcp-dialog-empty">
              No MCP servers yet. Add one to give this app the tools it provides.
            </Typography>
          )}

          {controller.servers.map(server => (
            <ServerRow
              key={server.id}
              server={server}
              controller={controller}
              onEdit={() => {
                setError(null);
                setDraft(draftFor(server));
              }}
            />
          ))}

          {draft ? (
            <>
              <Divider />
              <ServerForm
                draft={draft}
                setDraft={setDraft}
                error={error}
                busy={busy}
                onSave={() => void save()}
                onCancel={() => setDraft(null)}
              />
            </>
          ) : (
            <Button
              size="sm"
              variant="soft"
              startDecorator={<PlusIcon />}
              onClick={() => {
                setError(null);
                setDraft(emptyDraft());
              }}
              data-testid="mcp-dialog-add-btn"
            >
              Add server
            </Button>
          )}

          <Typography level="body-xs" textColor="text.tertiary">
            An MCP server is a program or endpoint you trust: it can declare any tool it likes. Every one of its tools
            asks you to approve each call, the same as a bash command, and nothing it says about itself can change what
            this app will do.
          </Typography>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
