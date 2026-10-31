import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Chip from '@mui/joy/Chip';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type {
  ModelServerAccess,
  ModelServerAuthKind,
  ModelServerCredentialInput,
  ModelServerKind,
  ModelServerMutationResult,
  ModelServerProbeResult,
  ModelServerSpecs,
  ModelServerState,
  ModelServerView,
} from '@shared/modelServers';
import { specsProblem } from '@shared/modelServers';
import { formatMemory, type MachineView } from '@shared/models';

const KIND_LABEL: Record<ModelServerKind, string> = { ollama: 'Ollama', 'openai-compatible': 'OpenAI-compatible' };
const ACCESS_LABEL: Record<ModelServerAccess, string> = { chat: 'Chat only', manage: 'Chat and manage' };
const STATE_LOOK: Record<ModelServerState, { color: 'success' | 'danger' | 'neutral' | 'warning'; label: string }> = {
  online: { color: 'success', label: 'Online' },
  unreachable: { color: 'danger', label: 'Unreachable' },
  credentials: { color: 'warning', label: 'Needs credentials' },
  refused: { color: 'danger', label: 'Refused' },
  unknown: { color: 'neutral', label: 'Checking' },
};

export function modelServersSummary(servers: readonly ModelServerView[] | null): string {
  if (!servers) return 'Loading';
  const others = servers.filter(server => !server.local);
  if (others.length === 0) return 'Only this computer. Add Ollama or an OpenAI-compatible server on another machine.';
  const online = others.filter(server => server.health.state === 'online').length;
  return `This computer and ${others.length} other ${others.length === 1 ? 'server' : 'servers'}, ${online} online`;
}

export function useModelServers() {
  const [servers, setServers] = useState<ModelServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.b4m.modelServers
      .list()
      .then(next => live && setServers(next))
      .catch(err => live && setError(`Could not load model servers. ${String(err)}`));
    const off = window.b4m.modelServers.onChanged(next => live && setServers(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [servers, setServers, error] as const;
}

/** One line of health: version, latency, when. */
export function healthLine(server: ModelServerView): string {
  const { health } = server;
  const parts = [
    health.version ? `${server.kind === 'ollama' ? 'Ollama ' : ''}${health.version}` : null,
    health.latencyMs !== null ? `${health.latencyMs} ms` : null,
    health.checkedAt ? `checked ${new Date(health.checkedAt).toLocaleTimeString()}` : null,
  ].filter(Boolean);
  return parts.join(' - ');
}

type CredentialDraft = { type: ModelServerAuthKind; token: string; headerName: string; headerValue: string };

const EMPTY_CREDENTIAL: CredentialDraft = { type: 'none', token: '', headerName: '', headerValue: '' };

/** A form for this server's current kind of credential; the secret itself never comes back from main. */
function draftFor(auth: ModelServerView['auth']): CredentialDraft {
  return { ...EMPTY_CREDENTIAL, type: auth.type, headerName: auth.headerName ?? '' };
}

function secretMissing(draft: CredentialDraft): boolean {
  if (draft.type === 'bearer') return !draft.token.trim();
  if (draft.type === 'header') return !draft.headerName.trim() || !draft.headerValue.trim();
  return false;
}

function toCredential(draft: CredentialDraft): ModelServerCredentialInput {
  if (draft.type === 'bearer') return { type: 'bearer', token: draft.token };
  if (draft.type === 'header') return { type: 'header', name: draft.headerName, value: draft.headerValue };
  return { type: 'none' };
}

function CredentialFields({
  draft,
  onChange,
  testPrefix,
}: {
  draft: CredentialDraft;
  onChange: (draft: CredentialDraft) => void;
  testPrefix: string;
}) {
  return (
    <Stack spacing={1}>
      <FormControl size="sm">
        <FormLabel>Credentials</FormLabel>
        <Select
          size="sm"
          value={draft.type}
          onChange={(_event, type) => type && onChange({ ...draft, type })}
          slotProps={{ button: { 'data-testid': `${testPrefix}-auth-select` } }}
        >
          <Option value="none" data-testid={`${testPrefix}-auth-none`}>
            None
          </Option>
          <Option value="bearer" data-testid={`${testPrefix}-auth-bearer`}>
            Bearer token
          </Option>
          <Option value="header" data-testid={`${testPrefix}-auth-header`}>
            Custom header
          </Option>
        </Select>
      </FormControl>
      {draft.type === 'bearer' && (
        <FormControl size="sm">
          <FormLabel>Token</FormLabel>
          <Input
            size="sm"
            type="password"
            value={draft.token}
            onChange={event => onChange({ ...draft, token: event.target.value })}
            slotProps={{ input: { 'data-testid': `${testPrefix}-token-input`, autoComplete: 'off' } }}
          />
        </FormControl>
      )}
      {draft.type === 'header' && (
        <Stack direction="row" spacing={1}>
          <FormControl size="sm" sx={{ flex: 1 }}>
            <FormLabel>Header name</FormLabel>
            <Input
              size="sm"
              value={draft.headerName}
              placeholder="X-Api-Key"
              onChange={event => onChange({ ...draft, headerName: event.target.value })}
              slotProps={{ input: { 'data-testid': `${testPrefix}-header-name-input` } }}
            />
          </FormControl>
          <FormControl size="sm" sx={{ flex: 2 }}>
            <FormLabel>Value</FormLabel>
            <Input
              size="sm"
              type="password"
              value={draft.headerValue}
              onChange={event => onChange({ ...draft, headerValue: event.target.value })}
              slotProps={{ input: { 'data-testid': `${testPrefix}-header-value-input`, autoComplete: 'off' } }}
            />
          </FormControl>
        </Stack>
      )}
    </Stack>
  );
}

type SpecsDraft = { ram: string; gpu: string; bandwidth: string; unified: boolean };

const figure = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));
const parsed = (value: string) => (value.trim() === '' ? null : Number(value));

function specsDraft(specs: ModelServerSpecs | null): SpecsDraft {
  return {
    ram: figure(specs?.ramGiB),
    gpu: figure(specs?.gpuMemoryGiB),
    bandwidth: figure(specs?.bandwidthGBps),
    unified: specs?.unified ?? false,
  };
}

function draftSpecs(draft: SpecsDraft): ModelServerSpecs {
  return {
    ramGiB: parsed(draft.ram),
    gpuMemoryGiB: parsed(draft.gpu),
    bandwidthGBps: parsed(draft.bandwidth),
    unified: draft.unified,
  };
}

export function specsSummary(specs: ModelServerSpecs): string {
  return [
    specs.ramGiB !== null ? `${specs.ramGiB} GB RAM${specs.unified ? ' shared with the GPU' : ''}` : null,
    specs.gpuMemoryGiB !== null ? `${specs.gpuMemoryGiB} GB GPU memory` : null,
    specs.bandwidthGBps !== null ? `${specs.bandwidthGBps} GB/s memory bandwidth` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export function probedSummary(machine: MachineView): string {
  const memory = formatMemory(machine.totalMemoryBytes);
  const gpu = machine.gpuMemoryBytes ? formatMemory(machine.gpuMemoryBytes) : null;
  const name = machine.gpuName ? ` (${machine.gpuName})` : '';
  // Worded like machineText in CuratedTab: only AMD unified memory reports a GPU budget, which may be a firmware
  // carve-out outside the RAM the OS sees rather than memory shared with it.
  if (machine.memoryKind === 'unified' && gpu)
    return `${memory} of RAM, and the GPU${name} can use ${machine.confidence === 'low' ? 'at least ' : ''}${gpu} of memory`;
  if (machine.memoryKind === 'unified') return `${memory} of memory shared with the GPU${name}`;
  if (machine.memoryKind === 'discrete' && gpu) return `${memory} of RAM and ${gpu} of GPU memory${name}`;
  return `${memory} of RAM and no GPU memory`;
}

/** Hardware typed in for a server, or in place of this computer's probe, which Models rates downloads against. */
function SpecsFields({
  server,
  busy,
  onSave,
  onDone,
}: {
  server: ModelServerView;
  busy: boolean;
  onSave: (specs: ModelServerSpecs | null) => Promise<boolean>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<SpecsDraft>(() => specsDraft(server.specs));
  const [problem, setProblem] = useState<string | null>(null);
  const [probed, setProbed] = useState<MachineView | null | undefined>(server.local ? undefined : null);

  useEffect(() => {
    if (!server.local) return;
    let live = true;
    void window.b4m.modelServers.probedHardware().then(
      machine => live && setProbed(machine),
      () => live && setProbed(null)
    );
    return () => {
      live = false;
    };
  }, [server.local]);

  const save = (specs: ModelServerSpecs | null) => {
    const issue = specs && specsProblem(specs, server.local);
    setProblem(issue ?? null);
    if (issue) return;
    void onSave(specs).then(ok => ok && onDone());
  };
  const placeholder = (bytes: number | null | undefined) =>
    bytes ? String(Math.round((bytes / 1024 ** 3) * 10) / 10) : undefined;
  const field = (key: 'ram' | 'gpu' | 'bandwidth', label: string, testId: string, hint?: string) => (
    <FormControl size="sm" sx={{ flex: 1, minWidth: 130 }}>
      <FormLabel>{label}</FormLabel>
      <Input
        size="sm"
        type="number"
        value={draft[key]}
        placeholder={hint}
        onChange={event => setDraft({ ...draft, [key]: event.target.value })}
        slotProps={{ input: { 'data-testid': testId, min: 0, step: 'any' } }}
      />
    </FormControl>
  );

  return (
    <Stack spacing={1} data-testid="model-servers-specs-form">
      <Typography level="body-xs" textColor="text.tertiary">
        {server.local
          ? 'Fill in only what Desktop detected wrong. Fit badges, Curated picks and chat context use these figures in place of the detected ones.'
          : 'Fit badges and Curated picks for this server use these figures. Without RAM its models stay unrated.'}
      </Typography>
      {server.local && probed !== undefined && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-specs-probed">
          {probed ? `Detected: ${probedSummary(probed)}.` : "Desktop could not detect this computer's hardware."}
        </Typography>
      )}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {field('ram', 'RAM (GB)', 'model-servers-specs-ram-input', placeholder(probed?.totalMemoryBytes))}
        {field('gpu', 'GPU memory (GB)', 'model-servers-specs-gpu-input', placeholder(probed?.gpuMemoryBytes))}
        {field('bandwidth', 'Memory bandwidth (GB/s)', 'model-servers-specs-bandwidth-input')}
      </Stack>
      {!server.local && (
        <Checkbox
          size="sm"
          label="The GPU shares this RAM (unified memory)"
          checked={draft.unified}
          onChange={event => setDraft({ ...draft, unified: event.target.checked })}
          slotProps={{ input: { 'data-testid': 'model-servers-specs-unified-checkbox' } }}
        />
      )}
      <Typography level="body-xs" textColor="text.tertiary">
        Ratings use the memory figures. Bandwidth is saved but does not change them yet.
      </Typography>
      {problem && (
        <Alert size="sm" color="danger" variant="soft" data-testid="model-servers-specs-error">
          {problem}
        </Alert>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => save(draftSpecs(draft))}
          data-testid="model-servers-specs-save-btn"
        >
          Save hardware
        </Button>
        {server.specs && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() => save(null)}
            data-testid="model-servers-specs-clear-btn"
          >
            {server.local ? 'Use detected hardware' : 'Clear'}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function ServerRow({
  server,
  onResult,
}: {
  server: ModelServerView;
  onResult: (result: ModelServerMutationResult) => void;
}) {
  const [editingSpecs, setEditingSpecs] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CredentialDraft>(() => draftFor(server.auth));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const look = STATE_LOOK[server.health.state];
  const askCredentials = !server.local && (server.health.state === 'credentials' || server.credentialsMissing);
  const removesCredential = draft.type === 'none' && server.auth.type !== 'none';
  const canSaveCredential = !secretMissing(draft) && (draft.type !== 'none' || removesCredential);

  const run = async (work: () => Promise<ModelServerMutationResult>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result.ok) onResult(result);
      else setError(result.error);
      return result.ok;
    } finally {
      setBusy(false);
    }
  };

  const update = (input: Parameters<typeof window.b4m.modelServers.update>[1]) =>
    run(() => window.b4m.modelServers.update(server.id, input));

  return (
    <Sheet
      variant="outlined"
      sx={{ p: 1.25, borderRadius: 'sm' }}
      data-testid="model-servers-row"
      data-server-id={server.id}
      data-state={server.health.state}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="title-sm" data-testid="model-servers-name">
            {server.name}
          </Typography>
          <Chip size="sm" variant="soft" color={look.color} data-testid="model-servers-status">
            {look.label}
          </Chip>
          <Chip size="sm" variant="outlined">
            {KIND_LABEL[server.kind]}
          </Chip>
          {server.unencrypted && (
            <Chip size="sm" variant="soft" color="warning" data-testid="model-servers-unencrypted-chip">
              Unencrypted
            </Chip>
          )}
          {server.toolsHint && (
            <Chip size="sm" variant="soft" color="warning" data-testid="model-servers-tools-off-chip">
              Tools off
            </Chip>
          )}
          {!server.local && server.auth.type !== 'none' && !server.credentialsPersisted && (
            <Chip size="sm" variant="soft" color="neutral" data-testid="model-servers-session-only-chip">
              Credentials kept until Desktop quits
            </Chip>
          )}
        </Stack>
        <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-address">
          {server.address}
          {server.auth.type === 'bearer' ? ' - bearer token' : ''}
          {server.auth.type === 'header' ? ` - ${server.auth.headerName} header` : ''}
        </Typography>
        {healthLine(server) && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-health">
            {healthLine(server)}
          </Typography>
        )}
        {server.health.error && server.health.state !== 'online' && (
          <Typography level="body-xs" textColor="danger.plainColor" data-testid="model-servers-error">
            {server.health.error}
          </Typography>
        )}
        {server.unencrypted && (
          <Typography level="body-xs" textColor="text.tertiary">
            Plain http on a private network: anyone on that network can read the conversation. Credentials are not sent
            over it.
          </Typography>
        )}
        {server.toolsHint && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-tools-hint">
            {server.toolsHint}
          </Typography>
        )}
        {!server.local && (
          <Stack direction="row" spacing={1} alignItems="flex-end" flexWrap="wrap" useFlexGap>
            <FormControl size="sm">
              <FormLabel>Access</FormLabel>
              <Select
                size="sm"
                value={server.access}
                disabled={busy}
                onChange={(_event, access) => access && void update({ access })}
                slotProps={{ button: { 'data-testid': 'model-servers-access-select' } }}
              >
                <Option value="chat">{ACCESS_LABEL.chat}</Option>
                <Option value="manage">{ACCESS_LABEL.manage}</Option>
              </Select>
            </FormControl>
            <FormControl size="sm">
              <FormLabel>Kind</FormLabel>
              <Select
                size="sm"
                value={server.kind}
                disabled={busy}
                onChange={(_event, kind) => kind && kind !== server.kind && void update({ kind })}
                slotProps={{ button: { 'data-testid': 'model-servers-kind-select' } }}
              >
                <Option value="ollama">{KIND_LABEL.ollama}</Option>
                <Option value="openai-compatible">{KIND_LABEL['openai-compatible']}</Option>
              </Select>
            </FormControl>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={busy}
              onClick={() => {
                if (!editing) setDraft(draftFor(server.auth));
                setEditing(!editing);
              }}
              data-testid="model-servers-credentials-btn"
            >
              {askCredentials ? 'Enter new credentials' : 'Credentials'}
            </Button>
          </Stack>
        )}
        {(editing || askCredentials) && !server.local && (
          <Stack spacing={1} data-testid="model-servers-credentials-form">
            <CredentialFields draft={draft} onChange={setDraft} testPrefix="model-servers-edit" />
            <Button
              size="sm"
              color={removesCredential ? 'danger' : 'primary'}
              disabled={busy || !canSaveCredential}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() =>
                void update({ credential: toCredential(draft) }).then(ok => {
                  if (ok) {
                    setEditing(false);
                    setDraft(saved => draftFor({ type: saved.type, headerName: saved.headerName }));
                  }
                })
              }
              data-testid="model-servers-credentials-save-btn"
            >
              {removesCredential ? 'Remove credential' : 'Save credentials'}
            </Button>
          </Stack>
        )}
        {!server.local && server.access === 'manage' && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-access-note">
            This setting is on this device only.{' '}
            {server.kind === 'ollama'
              ? 'Download and remove models on this server from the Models screen.'
              : 'Downloading and removing models works only on Ollama servers.'}
          </Typography>
        )}
        {server.specs && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="model-servers-specs-summary">
            Hardware entered: {specsSummary(server.specs)}.
          </Typography>
        )}
        {editingSpecs && (
          <SpecsFields
            server={server}
            busy={busy}
            onSave={specs => update({ specs })}
            onDone={() => setEditingSpecs(false)}
          />
        )}
        {error && (
          <Alert size="sm" color="danger" variant="soft" data-testid="model-servers-row-error">
            {error}
          </Alert>
        )}
        <Stack direction="row" spacing={1}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() =>
              void window.b4m.modelServers.check(server.id).then(servers => onResult({ ok: true, servers }))
            }
            data-testid="model-servers-recheck-btn"
          >
            Check now
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() => setEditingSpecs(open => !open)}
            data-testid="model-servers-specs-btn"
          >
            Hardware
          </Button>
          {!server.local &&
            (confirmRemove ? (
              <>
                <Button
                  size="sm"
                  color="danger"
                  disabled={busy}
                  onClick={() => void run(() => window.b4m.modelServers.remove(server.id))}
                  data-testid="model-servers-remove-confirm-btn"
                >
                  Remove {server.name}
                </Button>
                <Button size="sm" variant="plain" color="neutral" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="plain"
                color="danger"
                onClick={() => setConfirmRemove(true)}
                data-testid="model-servers-remove-btn"
              >
                Remove
              </Button>
            ))}
        </Stack>
      </Stack>
    </Sheet>
  );
}

function AddServer({ onResult }: { onResult: (result: ModelServerMutationResult) => void }) {
  const [address, setAddress] = useState('');
  const [credential, setCredential] = useState<CredentialDraft>(EMPTY_CREDENTIAL);
  const [probe, setProbe] = useState<ModelServerProbeResult | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ModelServerKind>('ollama');
  const [access, setAccess] = useState<ModelServerAccess>('chat');
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestedName = useRef<string | null>(null);
  // Bumped whenever the tested address or credential changes, so a probe still running for the old one is ignored.
  const attempt = useRef(0);

  const reset = useCallback(() => {
    setAddress('');
    setCredential(EMPTY_CREDENTIAL);
    setProbe(null);
    setName('');
    setAcceptOpen(false);
    setError(null);
    suggestedName.current = null;
    attempt.current += 1;
  }, []);

  // The "Save it anyway" answer was about the address and credentials the user tested, not new ones.
  const untest = () => {
    attempt.current += 1;
    setProbe(null);
    setAcceptOpen(false);
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      const tested = attempt.current;
      const result = await window.b4m.modelServers.probe({ address, credential: toCredential(credential) });
      if (tested !== attempt.current) return;
      setProbe(result);
      if (result.kind) setKind(result.kind);
      const suggested = result.suggestedName;
      if (suggested) {
        const previous = suggestedName.current;
        setName(current => (!current.trim() || current === previous ? suggested : current));
        suggestedName.current = suggested;
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.b4m.modelServers.add({
        address,
        credential: toCredential(credential),
        name,
        kind,
        access,
        acceptOpen,
      });
      if (result.ok) {
        onResult(result);
        reset();
      } else setError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const ready = !!probe?.ok && !!name.trim() && (!probe.openToAnyone || acceptOpen);

  return (
    <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'sm' }} data-testid="model-servers-add">
      <Stack spacing={1.25}>
        <Typography level="title-sm">Add a server</Typography>
        <FormControl size="sm">
          <FormLabel>Address</FormLabel>
          <Input
            size="sm"
            value={address}
            placeholder="https://gpu.example.com, http://192.168.1.20:11434 or host:port"
            onChange={event => {
              setAddress(event.target.value);
              untest();
            }}
            slotProps={{ input: { 'data-testid': 'model-servers-add-address-input' } }}
          />
          <FormHelperText>
            Ollama or an OpenAI-compatible server such as llama-server, LM Studio or vLLM.
          </FormHelperText>
        </FormControl>
        <CredentialFields
          draft={credential}
          onChange={next => {
            setCredential(next);
            untest();
          }}
          testPrefix="model-servers-add"
        />
        <Button
          size="sm"
          variant="outlined"
          disabled={busy || !address.trim()}
          loading={busy && !probe}
          sx={{ alignSelf: 'flex-start' }}
          onClick={() => void test()}
          data-testid="model-servers-add-test-btn"
        >
          Test
        </Button>
        {probe && !probe.ok && (
          <Alert
            size="sm"
            color={probe.needsCredentials ? 'warning' : 'danger'}
            variant="soft"
            data-testid="model-servers-add-result"
          >
            {probe.error}
            {probe.needsCredentials ? ' Choose a bearer token or a custom header above, then test again.' : ''}
          </Alert>
        )}
        {probe?.ok && (
          <Stack spacing={1.25}>
            <Alert size="sm" color="success" variant="soft" data-testid="model-servers-add-result">
              Found {probe.kind ? KIND_LABEL[probe.kind] : 'a server'}
              {probe.version ? ` ${probe.version}` : ''}
              {probe.models !== null ? `, ${probe.models} ${probe.models === 1 ? 'model' : 'models'}` : ''}
              {probe.latencyMs !== null ? `, ${probe.latencyMs} ms` : ''}.
            </Alert>
            {probe.unencrypted && (
              <Alert size="sm" color="warning" variant="soft" data-testid="model-servers-add-unencrypted">
                Unencrypted: plain http on a private network. Anyone on that network can read the conversation.
              </Alert>
            )}
            {probe.openToAnyone && (
              <Alert size="sm" color="danger" variant="soft" data-testid="model-servers-add-open-warning">
                <Stack spacing={1}>
                  <span>
                    This server is on the public internet and answers without credentials, so anyone who finds the
                    address can use it, including pulling and deleting models. Put it behind a proxy that asks for a
                    token.
                  </span>
                  <Checkbox
                    size="sm"
                    label="Save it anyway"
                    checked={acceptOpen}
                    onChange={event => setAcceptOpen(event.target.checked)}
                    slotProps={{ input: { 'data-testid': 'model-servers-add-accept-open-checkbox' } }}
                  />
                </Stack>
              </Alert>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <FormControl size="sm" sx={{ flex: 2, minWidth: 160 }}>
                <FormLabel>Name</FormLabel>
                <Input
                  size="sm"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  slotProps={{ input: { 'data-testid': 'model-servers-add-name-input' } }}
                />
              </FormControl>
              <FormControl size="sm" sx={{ flex: 1, minWidth: 160 }}>
                <FormLabel>Kind</FormLabel>
                <Select
                  size="sm"
                  value={kind}
                  onChange={(_event, next) => next && setKind(next)}
                  slotProps={{ button: { 'data-testid': 'model-servers-add-kind-select' } }}
                >
                  <Option value="ollama">{KIND_LABEL.ollama}</Option>
                  <Option value="openai-compatible">{KIND_LABEL['openai-compatible']}</Option>
                </Select>
              </FormControl>
              <FormControl size="sm" sx={{ flex: 1, minWidth: 160 }}>
                <FormLabel>Access</FormLabel>
                <Select
                  size="sm"
                  value={access}
                  onChange={(_event, next) => next && setAccess(next)}
                  slotProps={{ button: { 'data-testid': 'model-servers-add-access-select' } }}
                >
                  <Option value="chat">{ACCESS_LABEL.chat}</Option>
                  <Option value="manage">{ACCESS_LABEL.manage}</Option>
                </Select>
              </FormControl>
            </Stack>
            <Button
              size="sm"
              disabled={busy || !ready}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => void save()}
              data-testid="model-servers-add-save-btn"
            >
              Save server
            </Button>
          </Stack>
        )}
        {error && (
          <Alert size="sm" color="danger" variant="soft" data-testid="model-servers-add-error">
            {error}
          </Alert>
        )}
      </Stack>
    </Sheet>
  );
}

/** Settings, Model servers: "This computer" first, then each saved server, then the add form. */
export function ModelServersSettings({
  servers,
  onServers,
  loadError,
}: {
  servers: ModelServerView[] | null;
  onServers: (servers: ModelServerView[]) => void;
  loadError: string | null;
}) {
  const onResult = (result: ModelServerMutationResult) => {
    if (result.ok) onServers(result.servers);
  };
  if (loadError) {
    return (
      <Alert size="sm" color="danger" variant="soft">
        {loadError}
      </Alert>
    );
  }
  return (
    <Stack spacing={1.5} data-testid="model-servers">
      <Typography level="body-xs" textColor="text.tertiary">
        Models on these servers appear in the model picker, grouped by server. Credentials are stored with this
        computer&apos;s keyring and sent only to their own server.
      </Typography>
      {(servers ?? []).map(server => (
        <ServerRow key={server.id} server={server} onResult={onResult} />
      ))}
      <AddServer onResult={onResult} />
    </Stack>
  );
}
