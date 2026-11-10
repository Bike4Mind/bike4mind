import {
  useGetUserApiKeys,
  useCreateUserApiKey,
  useRotateUserApiKey,
  useRevokeUserApiKey,
  useUpdateEmbedKey,
  useBillingOrganizations,
  UpdateEmbedKeyRequest,
} from '@client/app/hooks/data/userApiKeys';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  ChipDelete,
  DialogContent,
  Dropdown,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  ListDivider,
  Menu,
  MenuButton,
  MenuItem,
  Option,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import CopyIcon from '@mui/icons-material/ContentCopy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import WarningIcon from '@mui/icons-material/Warning';
import {
  ApiKeyScope,
  EMBED_ORIGINS_MAX,
  IEmbedBranding,
  IOrganizationDocument,
  IUserApiKeyDocument,
  parseEmbedOrigin,
  WithId,
} from '@bike4mind/common';
import { coerceToOrigin } from '@client/app/components/common/EmbedAllowlistEditor';
import { useUser } from '@client/app/contexts/UserContext';
import {
  isModellessAgent,
  ModellessAgentAlert,
  MODELLESS_AGENT_WARNING,
} from '@client/app/components/common/ModellessAgentWarning';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY, normalizeTag } from '@bike4mind/server-utils/lib/entitlements/registry';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { useGetOrganization, useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { isRevoked, revocationTooltip } from '@client/app/utils/apiKeyRevocation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminDialogFooter,
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';

dayjs.extend(relativeTime);

const isEmbedKey = (key: IUserApiKeyDocument) => key.scopes.includes(ApiKeyScope.EMBED_CHAT);

const maskedPrefix = (prefix: string) => `${prefix}\u2022\u2022\u2022`;

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
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mb: 1 }}>
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
          sx={{ flex: 1, fontFamily: 'monospace' }}
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
 * for keys whose owner holds white-label, so for everyone else it rides through
 * from the stored key untouched - a full-replace save must not silently drop it.
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
  ownerHasWhitelabel,
}: {
  form: EmbedKeyFormState;
  onChange: (form: EmbedKeyFormState) => void;
  /**
   * Whether the key's billing OWNER holds white-label - the same owner-scoped,
   * no-bypass rule the serve and write paths enforce, so the toggle is only
   * offered when a save would actually take effect. Resolved by the caller
   * (Configure: the key's server-computed flag; Create: the prospective owner).
   */
  ownerHasWhitelabel: boolean;
}) {
  const { data: agents, isLoading: agentsLoading } = useGetAgents();

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
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }}>
          The embed key can only talk to this one agent.
        </Typography>
        {selectedAgentMissingModel && <ModellessAgentAlert testId="embed-key-model-warning" />}
      </FormControl>

      <EmbedOriginsField
        origins={form.allowedOrigins}
        onChange={allowedOrigins => onChange({ ...form, allowedOrigins })}
      />

      <Box>
        <Typography level="title-md" component="h3" sx={{ color: 'admin.ink', mb: 1 }}>
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
          {ownerHasWhitelabel ? (
            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
              <Box>
                <FormLabel>Hide Bike4Mind branding</FormLabel>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
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
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              How the widget presents itself on the host site. Hiding Bike4Mind branding requires the white-label plan.
            </Typography>
          )}
        </Stack>
      </Box>
    </>
  );
}

const emptyForm = (): EmbedKeyFormState => ({ agentId: '', allowedOrigins: [], branding: {} });

const orgOwnerHint = 'The organization that owns and is billed for this key.';

/**
 * Platform-admin branch of the org picker: a server-searched Autocomplete over
 * EVERY organization. It must NOT reuse SingleOrganizationSelector / the
 * useSearchUserOrganizations hook - those inject `filters.userId`, so even an
 * admin would only see the orgs they own or belong to. useSearchOrganizations
 * sends no userId, and /api/organizations returns all tenants for an admin, so
 * an admin can bill any org (which the create route's isAdmin bypass allows).
 * The picked org is remembered so it stays selected while the search term
 * changes, and cleared when the parent resets `value` after a successful mint.
 */
function AdminOrgPicker({ value, onChange }: { value?: string; onChange: (organizationId?: string) => void }) {
  const { debouncedValue: search, setValue: setSearch } = useDebounceValue('', 400);
  const { data, isLoading } = useSearchOrganizations({ page: 1, limit: 20, search });
  const [picked, setPicked] = useState<WithId<IOrganizationDocument> | null>(null);
  // Resolve the label for a value that isn't in the current search page and wasn't
  // picked here (e.g. a role flip re-mounts this picker with a pre-set org), so the
  // Autocomplete never looks empty while the parent still holds that organizationId.
  const { data: fetchedSelected } = useGetOrganization(value && !picked ? value : null);

  useEffect(() => {
    if (!value) setPicked(null);
  }, [value]);

  const options = data?.data ?? [];
  const selected = value ? (picked ?? options.find(org => org.id === value) ?? fetchedSelected ?? null) : null;
  // Keep the selected org present even when the current search filters it out.
  const mergedOptions = selected && !options.some(org => org.id === selected.id) ? [selected, ...options] : options;

  return (
    <FormControl required>
      <FormLabel>Organization</FormLabel>
      <Autocomplete
        placeholder="Search organizations"
        loading={isLoading}
        options={mergedOptions}
        value={selected}
        onChange={(_, org) => {
          setPicked(org);
          onChange(org?.id ?? undefined);
        }}
        onInputChange={(_, input, reason) => {
          // On select, MUI pushes the chosen label back through onInputChange
          // (reason 'reset'); don't treat that as a new search - it just triggers a
          // redundant refetch and narrows the next-open list to the one org.
          if (reason !== 'reset') setSearch(input ?? '');
        }}
        isOptionEqualToValue={(option, v) => option.id === v.id}
        getOptionLabel={option => option.name}
        data-testid="embed-key-org-admin-select"
      />
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }}>
        {orgOwnerHint}
      </Typography>
    </FormControl>
  );
}

/**
 * Non-admin branch: pick from the orgs the caller owns or manages
 * (billing-organizations == findIdsAdministeredBy), which is exactly what the
 * create route authorizes for a non-admin, so a selectable org can never 403 at
 * submit. A caller who administers none is told they cannot mint.
 */
function MemberOrgPicker({ value, onChange }: { value?: string; onChange: (organizationId?: string) => void }) {
  const { data: billingOrgs, isLoading } = useBillingOrganizations();

  if (!isLoading && (billingOrgs?.length ?? 0) === 0) {
    return (
      <FormControl required>
        <FormLabel>Organization</FormLabel>
        <Alert color="warning" startDecorator={<WarningIcon />} data-testid="embed-key-org-empty">
          <Typography level="body-sm">
            You do not administer any organization. Embed keys must be organization-owned, so ask an org owner or a
            platform admin to mint one.
          </Typography>
        </Alert>
      </FormControl>
    );
  }

  return (
    <FormControl required>
      <FormLabel>Organization</FormLabel>
      <Select
        value={value ?? null}
        onChange={(_, v) => onChange((v as string) ?? undefined)}
        placeholder={isLoading ? 'Loading organizations...' : 'Select the owning organization'}
        disabled={isLoading}
        data-testid="embed-key-org-select"
      >
        {billingOrgs?.map(org => (
          <Option key={org.id} value={org.id}>
            {org.name}
          </Option>
        ))}
      </Select>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }}>
        {orgOwnerHint}
      </Typography>
    </FormControl>
  );
}

/**
 * Required owning-organization picker for minting an embed key. Embed keys must
 * be org-owned - assertEmbedCredential rejects a user-owned key - so unlike the
 * optional "bill usage to" selector on personal keys, this has no personal
 * fallback and creation is blocked until an org is chosen. Split by role so each
 * branch mounts only its own data hook: a platform admin searches all orgs (see
 * AdminOrgPicker), everyone else picks from the orgs they administer. Lives
 * outside the shared EmbedKeyFormState because ownership is fixed at creation
 * and Configure must not expose it.
 */
function EmbedKeyOrganizationField({
  value,
  onChange,
}: {
  value?: string;
  onChange: (organizationId?: string) => void;
}) {
  const { currentUser } = useUser();
  return currentUser?.isAdmin ? (
    <AdminOrgPicker value={value} onChange={onChange} />
  ) : (
    <MemberOrgPicker value={value} onChange={onChange} />
  );
}

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
  const [organizationId, setOrganizationId] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<EmbedKeyFormState>(emptyForm());

  const resetForm = () => {
    setName('');
    setOrganizationId(undefined);
    setForm(emptyForm());
  };

  // The modal is parent-controlled via `open`, so it hides rather than unmounts;
  // reset on every close (cancel/backdrop) or a filled-then-cancelled form would
  // reappear pre-populated on reopen.
  const handleClose = () => {
    resetForm();
    onClose();
  };

  // The hide-branding toggle is UX-only. The minted key is org-owned, so its
  // authoritative owner is the chosen organization, not the minter - but the
  // server resolves the org's plan and strips an unentitled hideBranding on write
  // regardless. We gate the toggle we OFFER on the current user's own held
  // entitlements (no admin/developer bypass) as an up-front approximation; a
  // wrong guess is only cosmetic since the write path is the real enforcement.
  const { data: entitlements } = useEntitlements();
  const ownerHasWhitelabel = (entitlements ?? []).includes(normalizeTag(EMBED_WHITELABEL_ENTITLEMENT_KEY));

  const createMutation = useCreateUserApiKey({
    onSuccess: result => {
      onSuccess(result.key);
      onClose();
      resetForm();
    },
  });

  const handleSubmit = () =>
    createMutation.mutate({
      name,
      organizationId,
      scopes: [ApiKeyScope.EMBED_CHAT],
      agentId: form.agentId,
      allowedOrigins: form.allowedOrigins,
      branding: normalizeBranding(form.branding),
    });

  return (
    <AdminDialog
      open={open}
      onClose={handleClose}
      title="Create embed key"
      width={600}
      data-testid="embed-key-create-dialog"
    >
      <DialogContent sx={{ gap: 2.5 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
          A scoped, revocable credential that lets external sites chat with one bound agent.
        </Typography>

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

        <EmbedKeyOrganizationField value={organizationId} onChange={setOrganizationId} />

        <EmbedKeyFormFields form={form} onChange={setForm} ownerHasWhitelabel={ownerHasWhitelabel} />
      </DialogContent>
      <AdminDialogFooter>
        <Button variant="plain" color="neutral" onClick={handleClose} data-testid="embed-key-create-cancel-btn">
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          loading={createMutation.isPending}
          disabled={!name.trim() || !form.agentId || !organizationId}
          data-testid="embed-key-create-btn"
        >
          Create embed key
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
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
    <AdminDialog onClose={onClose} title="Configure embed key" width={600} data-testid="embed-key-configure-dialog">
      <DialogContent sx={{ gap: 2.5 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="embed-key-configure-subject">
          {embedKey.name}
          {' \u00b7 '}
          <Typography component="code" sx={{ fontFamily: 'code' }}>
            {maskedPrefix(embedKey.keyPrefix)}
          </Typography>
        </Typography>

        <EmbedKeyFormFields form={form} onChange={setForm} ownerHasWhitelabel={embedKey.ownerHasWhitelabel ?? false} />
      </DialogContent>
      <AdminDialogFooter>
        <Button variant="plain" color="neutral" onClick={onClose} data-testid="embed-key-configure-cancel-btn">
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          loading={updateMutation.isPending}
          disabled={!form.agentId}
          data-testid="embed-key-save-btn"
        >
          Save changes
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
  );
}

function EmbedKeyCreatedModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const [showKey, setShowKey] = useState(false);

  return (
    <AdminDialog onClose={onClose} title="Embed key created" width={600} data-testid="embed-key-created-dialog">
      <DialogContent sx={{ gap: 2 }}>
        <Alert color="warning" data-testid="embed-key-created-warning">
          This is the only time the full key is shown. Copy it now and store it securely.
        </Alert>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Input
            value={showKey ? apiKey : apiKey.replace(/./g, '\u2022')}
            readOnly
            sx={{ flex: 1, minWidth: 0, fontFamily: 'code' }}
            slotProps={{ input: { 'data-testid': 'embed-key-plaintext', 'aria-label': 'Embed key' } }}
          />
          <Tooltip title={showKey ? 'Hide key' : 'Show key'}>
            <IconButton
              variant="outlined"
              aria-label={showKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowKey(v => !v)}
            >
              {showKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={copied ? 'Copied!' : 'Copy key'}>
            <IconButton
              variant="outlined"
              aria-label="Copy key"
              onClick={() => handleCopyToClipboard(apiKey)}
              data-testid="embed-key-copy"
            >
              <CopyIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </DialogContent>
      <AdminDialogFooter>
        <Button onClick={onClose} data-testid="embed-key-created-done-btn">
          Done
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
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
  const [revokingKey, setRevokingKey] = useState<IUserApiKeyDocument | null>(null);
  const [rotatingKey, setRotatingKey] = useState<IUserApiKeyDocument | null>(null);

  const rotateMutation = useRotateUserApiKey({
    onSuccess: result => {
      setRotatingKey(null);
      setNewlyCreatedKey(result.key);
    },
  });
  const revokeMutation = useRevokeUserApiKey({
    onSuccess: () => toast.success('Embed key revoked'),
  });

  const embedKeys = (data ?? []).filter(isEmbedKey);

  const columns: DataColumn<IUserApiKeyDocument>[] = [
    {
      id: 'name',
      label: 'Name',
      render: key => (
        <Typography level="title-sm" noWrap sx={{ color: 'admin.ink', maxWidth: '16rem' }}>
          {key.name}
        </Typography>
      ),
      sortValue: key => key.name,
    },
    {
      id: 'agent',
      label: 'Agent',
      render: key => {
        const boundAgent = key.agentId ? agentById.get(key.agentId) : undefined;
        return (
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography level="body-sm" noWrap sx={{ color: 'admin.ink', maxWidth: '12rem' }}>
              {boundAgent?.name ?? key.agentId ?? 'Unbound'}
            </Typography>
            {isModellessAgent(boundAgent) && (
              <Tooltip title={MODELLESS_AGENT_WARNING}>
                <span>
                  <StatusChip tone="warn" label="No model" data-testid={`embed-key-row-model-warning-${key.id}`} />
                </span>
              </Tooltip>
            )}
          </Stack>
        );
      },
    },
    {
      id: 'keyPrefix',
      label: 'Key prefix',
      render: key => (
        <Typography level="body-sm" noWrap sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
          {maskedPrefix(key.keyPrefix)}
        </Typography>
      ),
    },
    {
      id: 'origins',
      label: 'Allowed origins',
      render: key =>
        key.allowedOrigins?.length ? (
          <Stack direction="row" gap={0.5}>
            {key.allowedOrigins.slice(0, 2).map(origin => (
              <StatusChip key={origin} tone="neutral" label={origin.replace(/^https:\/\//, '')} />
            ))}
            {key.allowedOrigins.length > 2 && <StatusChip tone="neutral" label={`+${key.allowedOrigins.length - 2}`} />}
          </Stack>
        ) : (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            None
          </Typography>
        ),
    },
    {
      id: 'status',
      label: 'Status',
      render: key => (
        <Tooltip title={revocationTooltip(key) ?? ''}>
          <span>
            <StatusChip
              tone={isRevoked(key) ? 'neutral' : 'good'}
              label={isRevoked(key) ? 'Revoked' : 'Active'}
              data-testid={`embed-key-status-${key.id}`}
            />
          </span>
        </Tooltip>
      ),
      sortValue: key => (isRevoked(key) ? 1 : 0),
    },
    {
      id: 'created',
      label: 'Created',
      render: key => (
        <Typography level="body-sm" noWrap>
          {dayjs(key.createdAt).format('MMM D, YYYY')}
        </Typography>
      ),
      sortValue: key => dayjs(key.createdAt).valueOf(),
    },
    {
      id: 'lastUsed',
      label: 'Last used',
      render: key => (
        <Typography level="body-sm" noWrap sx={{ color: 'admin.inkMuted' }}>
          {key.lastUsedAt ? dayjs(key.lastUsedAt).fromNow() : 'Never'}
        </Typography>
      ),
    },
  ];

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="embed-keys-tab">
      <AdminPageHeader
        title="Embed keys"
        description="Scoped credentials that let external sites embed a chat widget for one agent."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<RefreshIcon />}
              onClick={() => refetch()}
              data-testid="embed-key-refresh-btn"
            >
              Refresh
            </Button>
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              onClick={() => setShowNewKeyModal(true)}
              data-testid="embed-key-new-btn"
            >
              Create embed key
            </Button>
          </>
        }
      />

      <DataTable
        label="Embed keys"
        rows={embedKeys}
        columns={columns}
        getRowId={key => key.id}
        rowTestId={key => `embed-key-row-${key.id}`}
        loading={isLoading}
        error={error ? 'Could not load embed keys.' : undefined}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            title="No embed keys yet"
            description="Create one to let an external site chat with one of your agents."
            action={
              <Button
                size="sm"
                variant="outlined"
                startDecorator={<AddIcon />}
                onClick={() => setShowNewKeyModal(true)}
                data-testid="embed-key-empty-create-btn"
              >
                Create embed key
              </Button>
            }
          />
        }
        rowActions={key => (
          <EmbedKeyRowMenu
            embedKey={key}
            rotating={rotateMutation.isPending}
            onConfigure={() => setConfiguringKey(key)}
            onRotate={() => setRotatingKey(key)}
            onRevoke={() => setRevokingKey(key)}
          />
        )}
        testId="embed-key-table"
        // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
        minWidth="56rem"
      />

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
      {/* There is no way to un-revoke a key, so the admin types its name before the commit unlocks. */}
      <ActionDialog
        open={revokingKey !== null}
        // Esc, the X and the backdrop wait for an in-flight revoke, like the held Cancel.
        onClose={() => {
          if (!revokeMutation.isPending) setRevokingKey(null);
        }}
        title="Revoke embed key"
        description={
          <>
            Sites using <strong>{revokingKey?.name}</strong> stop working right away. A revoked key cannot be restored.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.embedKeyRevoke}
        tone="danger"
        // ActionDialog trims what the admin types, so the expected name is trimmed to match.
        typedConfirm={revokingKey ? { expected: revokingKey.name.trim(), noun: 'key name' } : undefined}
        confirmLabel="Revoke key"
        pending={revokeMutation.isPending}
        onConfirm={reason => {
          if (revokingKey) {
            revokeMutation.mutate({ keyId: revokingKey.id, reason }, { onSuccess: () => setRevokingKey(null) });
          }
        }}
        data-testid="embed-key-revoke-dialog"
      />
      {/* The rotate endpoint takes no reason, so the dialog collects one without sending it. */}
      <ActionDialog
        open={rotatingKey !== null}
        onClose={() => {
          if (!rotateMutation.isPending) setRotatingKey(null);
        }}
        title="Rotate embed key"
        description={
          <>
            Issues a new secret for <strong>{rotatingKey?.name}</strong>. The current one stops working at once, so
            sites using it fail until they get the new key, which is shown once.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.apiKeyRotate}
        reasonAudited={false}
        tone="danger"
        confirmLabel="Rotate key"
        pending={rotateMutation.isPending}
        onConfirm={() => {
          if (rotatingKey) rotateMutation.mutate(rotatingKey.id);
        }}
        data-testid="embed-key-rotate-dialog"
      />
    </Stack>
  );
}

/** The row's "..." menu. A revoked key has nothing left to change, so its menu is disabled. */
function EmbedKeyRowMenu({
  embedKey,
  rotating,
  onConfigure,
  onRotate,
  onRevoke,
}: {
  embedKey: IUserApiKeyDocument;
  rotating: boolean;
  onConfigure: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${embedKey.name}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        disabled={isRevoked(embedKey)}
        data-testid={`embed-key-row-actions-${embedKey.id}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        <MenuItem onClick={onConfigure} data-testid={`embed-key-configure-${embedKey.id}`}>
          Configure
        </MenuItem>
        <MenuItem onClick={onRotate} disabled={rotating} data-testid={`embed-key-rotate-${embedKey.id}`}>
          Rotate key
        </MenuItem>
        <ListDivider />
        <MenuItem color="danger" onClick={onRevoke} data-testid={`embed-key-revoke-${embedKey.id}`}>
          Revoke key
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}
