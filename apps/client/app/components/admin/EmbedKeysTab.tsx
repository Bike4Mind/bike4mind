import {
  useGetUserApiKeys,
  useCreateUserApiKey,
  useRotateUserApiKey,
  useRevokeUserApiKey,
  useUpdateEmbedKey,
  UpdateEmbedKeyRequest,
} from '@client/app/hooks/data/userApiKeys';
import {
  Alert,
  Box,
  Button,
  Chip,
  ChipDelete,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Switch,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import CopyIcon from '@mui/icons-material/ContentCopy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import SettingsIcon from '@mui/icons-material/Settings';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WarningIcon from '@mui/icons-material/Warning';
import {
  ApiKeyScope,
  EMBED_ORIGINS_MAX,
  IEmbedBranding,
  IUserApiKeyDocument,
  parseEmbedOrigin,
} from '@bike4mind/common';
import { coerceToOrigin } from '@client/app/components/common/EmbedAllowlistEditor';
import {
  isModellessAgent,
  ModellessAgentAlert,
  MODELLESS_AGENT_WARNING,
} from '@client/app/components/common/ModellessAgentWarning';
import { useEntitlementGate } from '@client/app/hooks/useEntitlementGate';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY } from '@client/lib/entitlements/registry';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { tableHeaderSx } from '@client/app/components/ProfileModal/settingsStyles';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const isEmbedKey = (key: IUserApiKeyDocument) => key.scopes.includes(ApiKeyScope.EMBED_CHAT);

/**
 * Controlled origin allow-list editor for an embed key. Unlike
 * EmbedAllowlistEditor (which persists each change against a published
 * artifact), this only edits local state - the parent form persists the whole
 * list on save, and the server re-validates every origin.
 */
function EmbedOriginsField({ origins, onChange }: { origins: string[]; onChange: (origins: string[]) => void }) {
  const [input, setInput] = useState('');

  const onAdd = () => {
    const parsed = parseEmbedOrigin(coerceToOrigin(input));
    if (!parsed) {
      toast.error('Enter a site like example.com (it becomes https://example.com)');
      return;
    }
    setInput('');
    if (origins.includes(parsed)) return;
    if (origins.length >= EMBED_ORIGINS_MAX) {
      toast.error(`Up to ${EMBED_ORIGINS_MAX} sites can use one embed key`);
      return;
    }
    onChange([...origins, parsed]);
  };

  return (
    <FormControl>
      <FormLabel>Allowed origins</FormLabel>
      <Typography level="body-xs" sx={{ color: 'text.tertiary', mb: 1 }}>
        The exact https sites (up to {EMBED_ORIGINS_MAX}) allowed to use this key. Empty means the key works nowhere
        yet.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: origins.length > 0 ? 1 : 0 }}>
        <Input
          value={input}
          placeholder="example.com"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          disabled={origins.length >= EMBED_ORIGINS_MAX}
          slotProps={{ input: { 'data-testid': 'embed-key-origin-input', autoComplete: 'off' } }}
          sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
        />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={origins.length >= EMBED_ORIGINS_MAX}
          onClick={onAdd}
          data-testid="embed-key-origin-add"
        >
          Allow
        </Button>
      </Box>
      {origins.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {origins.map(origin => (
            <Chip
              key={origin}
              variant="soft"
              color="neutral"
              data-testid={`embed-key-origin-chip-${origin}`}
              endDecorator={<ChipDelete onClick={() => onChange(origins.filter(o => o !== origin))} />}
            >
              {origin}
            </Chip>
          ))}
        </Box>
      )}
    </FormControl>
  );
}

interface EmbedKeyFormState {
  agentId: string;
  allowedOrigins: string[];
  branding: IEmbedBranding;
}

/**
 * Trim branding to undefined when every field is blank, so we never persist an
 * empty object. `hideBranding` is preserved verbatim: the toggle only renders
 * for whitelabel-entitled viewers, so for everyone else it rides through from
 * the stored key untouched - a full-replace save must not silently drop it.
 */
function normalizeBranding(branding: IEmbedBranding): IEmbedBranding | undefined {
  const displayName = branding.displayName?.trim() || undefined;
  const primaryColor = branding.primaryColor?.trim() || undefined;
  const logoUrl = branding.logoUrl?.trim() || undefined;
  const hideBranding = branding.hideBranding || undefined;
  if (!displayName && !primaryColor && !logoUrl && !hideBranding) return undefined;
  return { displayName, primaryColor, logoUrl, hideBranding };
}

const sameOrigins = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const sameBranding = (a?: IEmbedBranding, b?: IEmbedBranding) =>
  (a?.displayName ?? '') === (b?.displayName ?? '') &&
  (a?.primaryColor ?? '') === (b?.primaryColor ?? '') &&
  (a?.logoUrl ?? '') === (b?.logoUrl ?? '') &&
  (a?.hideBranding ?? false) === (b?.hideBranding ?? false);

/** Agent select + origin allow-list + branding fields, shared by create and configure. */
function EmbedKeyFormFields({
  form,
  onChange,
}: {
  form: EmbedKeyFormState;
  onChange: (form: EmbedKeyFormState) => void;
}) {
  const { data: agents, isLoading: agentsLoading } = useGetAgents();
  // Viewer-scoped and UX-only: it decides whether to OFFER the toggle, while the
  // serve route enforces on the key owner's plan and the write route strips an
  // unentitled elevation. `pending` renders like `denied` (no spinner flash in
  // an already-open modal). Known asymmetry: this gate bypasses for developers,
  // the server gates do not - a dev's toggle save is stripped server-side.
  const whitelabelGate = useEntitlementGate(EMBED_WHITELABEL_ENTITLEMENT_KEY);

  // Advisory only. An agent the viewer cannot see (or beyond the list's first
  // page) shows no warning - same degradation as the Select itself; the embed
  // route's 422 remains the enforcement layer.
  const selectedAgent = agents?.find(agent => agent.id === form.agentId);
  const selectedAgentMissingModel = isModellessAgent(selectedAgent);

  return (
    <>
      <FormControl required>
        <FormLabel>Agent</FormLabel>
        <Select
          value={form.agentId || null}
          onChange={(_, value) => onChange({ ...form, agentId: (value as string) ?? '' })}
          placeholder={agentsLoading ? 'Loading agents…' : 'Select the agent this key exposes'}
          data-testid="embed-key-agent-select"
        >
          {agents?.map(agent => (
            <Option key={agent.id} value={agent.id}>
              {agent.name}
            </Option>
          ))}
        </Select>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
          The embed key can only talk to this one agent.
        </Typography>
        {selectedAgentMissingModel && <ModellessAgentAlert testId="embed-key-model-warning" />}
      </FormControl>

      <EmbedOriginsField
        origins={form.allowedOrigins}
        onChange={allowedOrigins => onChange({ ...form, allowedOrigins })}
      />

      <Box>
        <Typography level="title-sm" mb={1}>
          Branding
        </Typography>
        <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>Display name</FormLabel>
            <Input
              placeholder="e.g., Acme Assistant"
              value={form.branding.displayName ?? ''}
              onChange={e => onChange({ ...form, branding: { ...form.branding, displayName: e.target.value } })}
              slotProps={{ input: { 'data-testid': 'embed-key-branding-name' } }}
            />
          </FormControl>
          <Stack direction="row" spacing={2}>
            <FormControl sx={{ flex: 1 }}>
              <FormLabel>Primary color</FormLabel>
              <Input
                placeholder="#336699"
                value={form.branding.primaryColor ?? ''}
                onChange={e => onChange({ ...form, branding: { ...form.branding, primaryColor: e.target.value } })}
                slotProps={{ input: { 'data-testid': 'embed-key-branding-color' } }}
              />
            </FormControl>
            <FormControl sx={{ flex: 2 }}>
              <FormLabel>Logo URL</FormLabel>
              <Input
                placeholder="https://example.com/logo.png"
                value={form.branding.logoUrl ?? ''}
                onChange={e => onChange({ ...form, branding: { ...form.branding, logoUrl: e.target.value } })}
                slotProps={{ input: { 'data-testid': 'embed-key-branding-logo' } }}
              />
            </FormControl>
          </Stack>
          {whitelabelGate.state === 'satisfied' ? (
            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
              <Box>
                <FormLabel>Hide Bike4Mind branding</FormLabel>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  Removes the powered-by footer. Applied only when this key&apos;s plan includes white-label - the
                  server enforces it per key owner.
                </Typography>
              </Box>
              <Switch
                checked={form.branding.hideBranding ?? false}
                onChange={e => onChange({ ...form, branding: { ...form.branding, hideBranding: e.target.checked } })}
                slotProps={{ input: { 'data-testid': 'embed-key-branding-hide' } }}
              />
            </FormControl>
          ) : (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              How the widget presents itself on the host site. Hiding Bike4Mind branding requires the white-label plan.
            </Typography>
          )}
        </Stack>
      </Box>
    </>
  );
}

const emptyForm = (): EmbedKeyFormState => ({ agentId: '', allowedOrigins: [], branding: {} });

function NewEmbedKeyModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (key: string) => void;
}) {
  const [name, setName] = useState('');
  const [form, setForm] = useState<EmbedKeyFormState>(emptyForm());

  const createMutation = useCreateUserApiKey({
    onSuccess: result => {
      onSuccess(result.key);
      onClose();
      setName('');
      setForm(emptyForm());
    },
  });

  const handleSubmit = () =>
    createMutation.mutate({
      name,
      scopes: [ApiKeyScope.EMBED_CHAT],
      agentId: form.agentId,
      allowedOrigins: form.allowedOrigins,
      branding: normalizeBranding(form.branding),
    });

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog size="lg" sx={{ width: '600px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}>
        <Typography level="h4">Create Embed Key</Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5, mb: 2 }}>
          A scoped, revocable credential that lets external sites chat with one bound agent.
        </Typography>

        <Stack spacing={2.5}>
          <FormControl required>
            <FormLabel>Name</FormLabel>
            <Input
              autoFocus
              placeholder="e.g., Acme marketing site"
              value={name}
              onChange={e => setName(e.target.value)}
              data-testid="embed-key-name-input"
            />
          </FormControl>

          <EmbedKeyFormFields form={form} onChange={setForm} />

          <Stack direction="row" spacing={2} justifyContent="flex-end">
            <Button variant="outlined" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              loading={createMutation.isPending}
              disabled={!name.trim() || !form.agentId}
              data-testid="embed-key-create-btn"
            >
              Create Embed Key
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

function ConfigureEmbedKeyModal({ embedKey, onClose }: { embedKey: IUserApiKeyDocument | null; onClose: () => void }) {
  // Keyed remount (see call site) seeds the form from the key being configured.
  const [form, setForm] = useState<EmbedKeyFormState>(() =>
    embedKey
      ? {
          agentId: embedKey.agentId ?? '',
          allowedOrigins: embedKey.allowedOrigins ?? [],
          branding: embedKey.branding ?? {},
        }
      : emptyForm()
  );

  const updateMutation = useUpdateEmbedKey({
    onSuccess: () => {
      toast.success('Embed key updated');
      onClose();
    },
  });

  if (!embedKey) return null;

  // Send only the fields the admin actually changed, so the update stays a true
  // partial (untouched branding - including a plan-gated `hideBranding` - is left
  // alone server-side) and the UPDATED analytics event reports the real diff.
  const handleSubmit = () => {
    const request: UpdateEmbedKeyRequest = { keyId: embedKey.id };
    if (form.agentId !== (embedKey.agentId ?? '')) request.agentId = form.agentId;
    if (!sameOrigins(form.allowedOrigins, embedKey.allowedOrigins ?? [])) {
      request.allowedOrigins = form.allowedOrigins;
    }
    const nextBranding = normalizeBranding(form.branding);
    if (!sameBranding(nextBranding, embedKey.branding)) request.branding = nextBranding ?? {};

    if (request.agentId === undefined && request.allowedOrigins === undefined && request.branding === undefined) {
      onClose();
      return;
    }
    updateMutation.mutate(request);
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog size="lg" sx={{ width: '600px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}>
        <Typography level="h4">Configure Embed Key</Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5, mb: 2 }}>
          {embedKey.name} · <code>{embedKey.keyPrefix}•••</code>
        </Typography>

        <Stack spacing={2.5}>
          <EmbedKeyFormFields form={form} onChange={setForm} />

          <Stack direction="row" spacing={2} justifyContent="flex-end">
            <Button variant="outlined" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              loading={updateMutation.isPending}
              disabled={!form.agentId}
              data-testid="embed-key-save-btn"
            >
              Save Changes
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

function EmbedKeyCreatedModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const [showKey, setShowKey] = useState(false);

  return (
    <Modal open onClose={onClose}>
      <ModalDialog size="lg" sx={{ width: '600px', maxWidth: '95vw' }}>
        <Typography level="h4">Embed Key Created</Typography>
        <Alert color="warning" startDecorator={<WarningIcon />} sx={{ my: 1.5 }}>
          <Typography level="body-sm">
            This is the only time the full key is shown. Copy it now and store it securely.
          </Typography>
        </Alert>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Input
            value={showKey ? apiKey : apiKey.replace(/./g, '•')}
            readOnly
            sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
            slotProps={{ input: { 'data-testid': 'embed-key-plaintext' } }}
          />
          <Tooltip title={showKey ? 'Hide key' : 'Show key'}>
            <IconButton variant="outlined" onClick={() => setShowKey(v => !v)}>
              {showKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={copied ? 'Copied!' : 'Copy key'}>
            <IconButton variant="outlined" onClick={() => handleCopyToClipboard(apiKey)} data-testid="embed-key-copy">
              <CopyIcon />
            </IconButton>
          </Tooltip>
        </Box>
        <Stack direction="row" justifyContent="flex-end" mt={2}>
          <Button onClick={onClose}>Done</Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

/**
 * Admin surface to create, configure, and revoke embed keys (epic #41 Phase E):
 * scoped `embed:chat` credentials that bind one agent, an https origin
 * allow-list, and optional white-label branding.
 */
export default function EmbedKeysTab() {
  const { data, isLoading, error, refetch } = useGetUserApiKeys();
  const { data: agents } = useGetAgents();
  const agentById = useMemo(() => new Map((agents ?? []).map(agent => [agent.id, agent])), [agents]);

  const [showNewKeyModal, setShowNewKeyModal] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState('');
  const [configuringKey, setConfiguringKey] = useState<IUserApiKeyDocument | null>(null);

  const rotateMutation = useRotateUserApiKey({
    onSuccess: result => setNewlyCreatedKey(result.key),
  });
  const revokeMutation = useRevokeUserApiKey({
    onSuccess: () => toast.success('Embed key revoked'),
  });

  const embedKeys = (data ?? []).filter(isEmbedKey);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1.5}>
        <Box>
          <Typography level="title-md" sx={{ color: 'text.primary' }}>
            Embed Keys
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Scoped credentials that let external sites embed a chat widget for one agent.
          </Typography>
        </Box>
        <Box display="flex" gap={1} flexShrink={0}>
          <Tooltip title="Refresh">
            <IconButton onClick={() => refetch()} variant="outlined">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Button
            startDecorator={<AddIcon />}
            onClick={() => setShowNewKeyModal(true)}
            variant="solid"
            data-testid="embed-key-new-btn"
          >
            Create Embed Key
          </Button>
        </Box>
      </Box>

      {isLoading ? (
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
          <CircularProgress />
        </Box>
      ) : error ? (
        <Box p={2}>
          <Typography color="danger">Error loading embed keys</Typography>
          <Button onClick={() => refetch()} variant="soft" sx={{ mt: 2 }}>
            Retry
          </Button>
        </Box>
      ) : embedKeys.length === 0 ? (
        <Alert color="neutral" startDecorator={<InfoOutlinedIcon />}>
          <Typography>No embed keys yet. Create one to let an external site chat with one of your agents.</Typography>
        </Alert>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table
            stickyHeader
            hoverRow
            sx={{
              minWidth: 860,
              tableLayout: 'auto',
              '& th, & td': { whiteSpace: 'nowrap' },
              '& thead th': tableHeaderSx,
            }}
          >
            <thead>
              <tr>
                <th>Name</th>
                <th>Agent</th>
                <th>Key Prefix</th>
                <th>Allowed Origins</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {embedKeys.map(key => {
                const disabled = key.status === 'disabled';
                const boundAgent = key.agentId ? agentById.get(key.agentId) : undefined;
                return (
                  <tr key={key.id} data-testid={`embed-key-row-${key.id}`}>
                    <td>
                      <Typography fontWeight="lg">{key.name}</Typography>
                    </td>
                    <td>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Chip size="sm" variant="soft" color="primary">
                          {boundAgent?.name ?? key.agentId ?? 'Unbound'}
                        </Chip>
                        {isModellessAgent(boundAgent) && (
                          <Tooltip title={MODELLESS_AGENT_WARNING}>
                            <WarningIcon
                              color="warning"
                              fontSize="small"
                              aria-label={MODELLESS_AGENT_WARNING}
                              data-testid={`embed-key-row-model-warning-${key.id}`}
                            />
                          </Tooltip>
                        )}
                      </Box>
                    </td>
                    <td>
                      <Typography fontFamily="monospace" fontSize="sm">
                        {key.keyPrefix}•••
                      </Typography>
                    </td>
                    <td>
                      {key.allowedOrigins?.length ? (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {key.allowedOrigins.slice(0, 2).map(origin => (
                            <Chip key={origin} size="sm" variant="soft">
                              {origin.replace(/^https:\/\//, '')}
                            </Chip>
                          ))}
                          {key.allowedOrigins.length > 2 && (
                            <Chip size="sm" variant="soft" color="neutral">
                              +{key.allowedOrigins.length - 2}
                            </Chip>
                          )}
                        </Box>
                      ) : (
                        <Typography level="body-xs" color="neutral">
                          None
                        </Typography>
                      )}
                    </td>
                    <td>
                      <Chip variant="soft" color={disabled ? 'danger' : 'success'}>
                        {disabled ? 'Revoked' : 'Active'}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-xs">{dayjs(key.createdAt).format('MMM D, YYYY')}</Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" color="neutral">
                        {key.lastUsedAt ? dayjs(key.lastUsedAt).fromNow() : 'Never'}
                      </Typography>
                    </td>
                    <td>
                      <Box display="flex" gap={1}>
                        <Tooltip title="Configure">
                          <IconButton
                            size="sm"
                            variant="outlined"
                            onClick={() => setConfiguringKey(key)}
                            disabled={disabled}
                            data-testid={`embed-key-configure-${key.id}`}
                          >
                            <SettingsIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Rotate key">
                          <IconButton
                            size="sm"
                            variant="outlined"
                            onClick={() => rotateMutation.mutate(key.id)}
                            loading={rotateMutation.isPending}
                            disabled={disabled}
                          >
                            <RotateLeftIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Revoke key">
                          <IconButton
                            size="sm"
                            variant="outlined"
                            color="danger"
                            onClick={() => revokeMutation.mutate({ keyId: key.id, reason: 'Revoked by admin' })}
                            loading={revokeMutation.isPending}
                            disabled={disabled}
                            data-testid={`embed-key-revoke-${key.id}`}
                          >
                            <BlockIcon />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Box>
      )}

      <NewEmbedKeyModal
        open={showNewKeyModal}
        onClose={() => setShowNewKeyModal(false)}
        onSuccess={setNewlyCreatedKey}
      />
      {/* key= remounts the form when a different key is opened */}
      <ConfigureEmbedKeyModal
        key={configuringKey?.id ?? 'none'}
        embedKey={configuringKey}
        onClose={() => setConfiguringKey(null)}
      />
      {newlyCreatedKey && <EmbedKeyCreatedModal apiKey={newlyCreatedKey} onClose={() => setNewlyCreatedKey('')} />}
    </Box>
  );
}
