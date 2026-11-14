import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  DialogContent,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  MenuItem,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import CopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  OAUTH_CLIENT_SCOPES,
  OAUTH_FEDERATED_DEFAULT_SCOPES,
  isOAuthClientScope,
  isOptInScope,
  type CreateOAuthClientInput,
  type OAuthClientView,
  type OAuthClientWithSecret,
  type OAuthFederatedIdpInput,
  type UpdateOAuthClientInput,
} from '@bike4mind/common';
import {
  fetchOAuthClients,
  createOAuthClient,
  updateOAuthClient,
  rotateOAuthClientSecret,
} from '@client/app/utils/oauthClientAPICalls';
import { isAxiosError } from 'axios';
import { getErrorMessage } from '@client/app/utils/error';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { RowActionsMenu } from './shared/RowActionsMenu';

const QUERY_KEY = 'admin-oauth-clients';

type FederatedForm = {
  enabled: boolean;
  subjectSource: 'identities' | 'sub';
  issuer: string;
  audience: string;
  providerName: string;
  jwksUri: string;
};

type CreateForm = {
  name: string;
  redirectUris: string;
  firstParty: boolean;
  federated: FederatedForm;
  unpaidAccountsAllowed: boolean;
};

const emptyCreateForm: CreateForm = {
  name: '',
  redirectUris: '',
  firstParty: false,
  federated: { enabled: false, subjectSource: 'sub', issuer: '', audience: '', providerName: '', jwksUri: '' },
  unpaidAccountsAllowed: true,
};

const parseUris = (text: string) =>
  text
    .split('\n')
    .map(uri => uri.trim())
    .filter(Boolean);

const blankToUndefined = (value: string) => value.trim() || undefined;

const federatedInput = (f: FederatedForm): OAuthFederatedIdpInput => ({
  subjectSource: f.subjectSource,
  issuer: blankToUndefined(f.issuer),
  audience: blankToUndefined(f.audience),
  jwksUri: blankToUndefined(f.jwksUri),
  ...(f.subjectSource === 'identities' ? { providerName: blankToUndefined(f.providerName) } : {}),
});

export function buildCreatePayload(form: CreateForm): CreateOAuthClientInput {
  return {
    name: form.name,
    redirectUris: parseUris(form.redirectUris),
    clientType: form.firstParty ? 'first-party' : 'relying-party',
    ...(form.federated.enabled ? { federatedIdp: federatedInput(form.federated) } : {}),
    ...(form.federated.enabled && !form.unpaidAccountsAllowed ? { unpaidAccountsAllowed: false } : {}),
  };
}

type EditForm = {
  redirectUris: string;
  scopes: string[];
  federated: FederatedForm;
  overwatchProductId: string;
  unpaidAccountsAllowed: boolean;
};

// A stored trust config without subjectSource is the 'identities' shape (see resolveOAuthFederatedIdp).
export function federatedFormFromClient(client: OAuthClientView): FederatedForm {
  const idp = client.federatedIdp;
  return {
    enabled: !!idp,
    subjectSource: idp?.subjectSource ?? 'identities',
    issuer: idp?.issuer ?? '',
    audience: idp?.audience ?? '',
    providerName: idp?.providerName ?? '',
    jwksUri: idp?.jwksUri ?? '',
  };
}

export const editFormFromClient = (client: OAuthClientView): EditForm => ({
  redirectUris: client.redirectUris.join('\n'),
  scopes: client.allowedScopes,
  federated: federatedFormFromClient(client),
  overwatchProductId: client.overwatchProductId ?? '',
  unpaidAccountsAllowed: client.unpaidAccountsAllowed !== false,
});

/** Only the fields the admin changed, so an unrelated save never trips the server's concurrent-edit guards. */
export function buildEditPayload(client: OAuthClientView, form: EditForm): UpdateOAuthClientInput {
  const payload: UpdateOAuthClientInput = {};

  const uris = parseUris(form.redirectUris);
  if (JSON.stringify(uris) !== JSON.stringify(client.redirectUris)) payload.redirectUris = uris;

  const stored = new Set(client.allowedScopes);
  const wanted = new Set(form.scopes);
  if (stored.size !== wanted.size || [...wanted].some(scope => !stored.has(scope))) {
    payload.allowedScopes = [
      ...client.allowedScopes.filter(scope => wanted.has(scope)),
      ...OAUTH_CLIENT_SCOPES.filter(scope => wanted.has(scope) && !stored.has(scope)),
    ];
  }

  const before = federatedFormFromClient(client);
  const after = form.federated;
  if (after.enabled !== before.enabled || (after.enabled && JSON.stringify(after) !== JSON.stringify(before))) {
    payload.federatedIdp = after.enabled ? federatedInput(after) : null;
  }

  const product = form.overwatchProductId.trim();
  if (product !== (client.overwatchProductId ?? '')) payload.overwatchProductId = product || null;
  if (form.unpaidAccountsAllowed !== (client.unpaidAccountsAllowed !== false)) {
    payload.unpaidAccountsAllowed = form.unpaidAccountsAllowed;
  }
  return payload;
}

export const removedScopes = (client: OAuthClientView, payload: UpdateOAuthClientInput): string[] =>
  payload.allowedScopes ? client.allowedScopes.filter(scope => !payload.allowedScopes?.includes(scope)) : [];

function FederatedTrustFields({
  value,
  onChange,
  testIdPrefix,
  audiencePlaceholder,
}: {
  value: FederatedForm;
  onChange: (patch: Partial<FederatedForm>) => void;
  testIdPrefix: string;
  audiencePlaceholder: string;
}) {
  return (
    <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm' }}>
      <Stack spacing={1.25}>
        <FormControl>
          <FormLabel>Subject source</FormLabel>
          <Select
            value={value.subjectSource}
            onChange={(_e, v) => v && onChange({ subjectSource: v })}
            data-testid={`${testIdPrefix}-subject-select`}
          >
            <Option value="sub">sub - app signs in against B4M directly</Option>
            <Option value="identities">identities - app&apos;s Cognito pool federates B4M</Option>
          </Select>
        </FormControl>
        <FormControl required>
          <FormLabel>Issuer</FormLabel>
          <Input
            value={value.issuer}
            onChange={e => onChange({ issuer: e.target.value })}
            slotProps={{ input: { 'data-testid': `${testIdPrefix}-issuer-input` } }}
          />
        </FormControl>
        <FormControl required={value.subjectSource === 'identities'}>
          <FormLabel>Audience</FormLabel>
          <Input
            placeholder={value.subjectSource === 'sub' ? audiencePlaceholder : ''}
            value={value.audience}
            onChange={e => onChange({ audience: e.target.value })}
            slotProps={{ input: { 'data-testid': `${testIdPrefix}-audience-input` } }}
          />
        </FormControl>
        {value.subjectSource === 'identities' && (
          <FormControl required>
            <FormLabel>Provider name</FormLabel>
            <Input
              value={value.providerName}
              onChange={e => onChange({ providerName: e.target.value })}
              slotProps={{ input: { 'data-testid': `${testIdPrefix}-provider-input` } }}
            />
          </FormControl>
        )}
        <FormControl required={value.subjectSource === 'sub'}>
          <FormLabel>JWKS URI</FormLabel>
          <Input
            placeholder={
              value.subjectSource === 'sub' ? '<issuer>/api/oauth/jwks' : 'Defaults to <issuer>/.well-known/jwks.json'
            }
            value={value.jwksUri}
            onChange={e => onChange({ jwksUri: e.target.value })}
            slotProps={{ input: { 'data-testid': `${testIdPrefix}-jwks-input` } }}
          />
        </FormControl>
      </Stack>
    </Sheet>
  );
}

function UnpaidAccountsToggle({
  checked,
  onChange,
  testid,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  testid: string;
}) {
  return (
    <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Box>
        <FormLabel>Starter and free accounts may use this app</FormLabel>
        <FormHelperText sx={{ mt: 0 }}>
          Under the paid-only API key switch, keys from this app&apos;s AI-token exchange work for accounts without a
          paid plan. Off keeps this app paid-only.
        </FormHelperText>
      </Box>
      <Switch
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        slotProps={{ input: { 'data-testid': testid } }}
      />
    </FormControl>
  );
}

function CopyField({ label, value, testid }: { label: string; value: string; testid: string }) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  return (
    <FormControl>
      <FormLabel>{label}</FormLabel>
      <Stack direction="row" spacing={1} alignItems="center">
        <Input
          value={value}
          readOnly
          sx={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}
          slotProps={{ input: { 'data-testid': `${testid}-value` } }}
        />
        <Tooltip title={copied ? 'Copied!' : `Copy ${label.toLowerCase()}`}>
          <IconButton
            variant="outlined"
            onClick={() => handleCopyToClipboard(value)}
            data-testid={`${testid}-copy-btn`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      </Stack>
    </FormControl>
  );
}

function SecretModal({
  result,
  rotated,
  onClose,
}: {
  result: OAuthClientWithSecret;
  rotated: boolean;
  onClose: () => void;
}) {
  return (
    <AdminDialog
      title={rotated ? 'Client secret rotated' : 'OAuth client registered'}
      width={640}
      // AdminDialog hands Joy's close reason through. The secret is shown once, so Esc and a backdrop
      // click must not dismiss it. The close button (reason closeClick) and Done close it; Esc and
      // backdrop are pinned in OAuthClientsTab.test.tsx.
      onClose={(_event?: unknown, reason?: string) => {
        if (reason === 'backdropClick' || reason === 'escapeKeyDown') return;
        onClose();
      }}
      data-testid="oauth-client-secret-modal"
    >
      <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
        {result.client.name}
      </Typography>
      <Alert color="warning" startDecorator={<WarningRoundedIcon />} sx={{ my: 1.5 }}>
        <Typography level="body-sm" data-testid="oauth-client-secret-notice">
          The client secret will not be shown again. Copy it now and store it in the app&apos;s secret manager.
          {rotated && ' The previous secret has stopped working.'}
        </Typography>
      </Alert>
      <Stack spacing={1.5}>
        <CopyField label="Client ID" value={result.client.clientId} testid="oauth-client-secret-modal-client-id" />
        <CopyField label="Client secret" value={result.clientSecret} testid="oauth-client-secret-modal-secret" />
      </Stack>
      <Stack direction="row" justifyContent="flex-end" mt={2}>
        <Button onClick={onClose} data-testid="oauth-client-secret-done-btn">
          Done
        </Button>
      </Stack>
    </AdminDialog>
  );
}

/** DataTable hides `[data-row-actions]` until the row is hovered or focused, so the copy button appears on hover. */
function ClientIdCell({ clientId }: { clientId: string }) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  return (
    <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0 }}>
      <Typography level="body-xs" noWrap title={clientId} sx={{ fontFamily: 'monospace', minWidth: 0 }}>
        {clientId}
      </Typography>
      <Box data-row-actions sx={{ display: 'inline-flex', flexShrink: 0 }}>
        <Tooltip title={copied ? 'Copied' : 'Copy client ID'}>
          <IconButton
            size="sm"
            variant="plain"
            aria-label="Copy client ID"
            onClick={() => handleCopyToClipboard(clientId)}
            data-testid={`oauth-client-copy-id-${clientId}`}
            sx={{ '--IconButton-size': '22px', minHeight: 22, minWidth: 22, color: 'admin.inkMuted' }}
          >
            {copied ? <CheckIcon sx={{ fontSize: 14 }} /> : <CopyIcon sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>
      </Box>
    </Stack>
  );
}

const isConfidential = (client: OAuthClientView) => client.tokenEndpointAuthMethod === 'client_secret_post';

function ClientRowMenu({
  client,
  onEdit,
  onRotate,
}: {
  client: OAuthClientView;
  onEdit: () => void;
  onRotate: () => void;
}) {
  return (
    <RowActionsMenu testId={`oauth-client-actions-${client.clientId}`} ariaLabel={`Actions for ${client.name}`}>
      <MenuItem onClick={onEdit} data-testid={`oauth-client-edit-${client.clientId}`}>
        Edit client
      </MenuItem>
      {isConfidential(client) && (
        <MenuItem onClick={onRotate} data-testid={`oauth-client-rotate-${client.clientId}`}>
          Rotate secret
        </MenuItem>
      )}
    </RowActionsMenu>
  );
}

export default function OAuthClientsTab() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<OAuthClientView | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [narrowing, setNarrowing] = useState<{
    removed: string[];
    dropsTrust: boolean;
    payload: UpdateOAuthClientInput;
  } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<OAuthClientView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<OAuthClientView | null>(null);
  // The secret is held in state and in the create/rotate mutation result; both are cleared when the modal closes (gcTime 0).
  const [secretResult, setSecretResult] = useState<{ result: OAuthClientWithSecret; rotated: boolean } | null>(null);

  const {
    data: clients = [],
    isPending,
    isError,
    error: listError,
    refetch,
  } = useQuery({ queryKey: [QUERY_KEY], queryFn: fetchOAuthClients });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });

  const createMutation = useMutation({
    mutationFn: () => createOAuthClient(buildCreatePayload(createForm)),
    gcTime: 0,
    onSuccess: result => {
      invalidate();
      setCreateOpen(false);
      setSecretResult({ result, rotated: false });
    },
    onError: (error: unknown) => setFormError(getErrorMessage(error)),
  });

  const editMutation = useMutation({
    mutationFn: ({ client, payload }: { client: OAuthClientView; payload: UpdateOAuthClientInput }) =>
      updateOAuthClient(client.id, { ...payload, expectedUpdatedAt: client.updatedAt }),
    onSuccess: client => {
      invalidate();
      setNarrowing(null);
      setEditTarget(null);
      toast.success(`Updated ${client.name}`);
    },
    onError: (error: unknown) => {
      invalidate();
      setNarrowing(null);
      const message = getErrorMessage(error);
      setFormError(
        isAxiosError(error) && error.response?.status === 409
          ? `${message} Close and reopen this client to load the latest changes.`
          : message
      );
    },
  });

  const activeMutation = useMutation({
    mutationFn: ({ client, isActive }: { client: OAuthClientView; isActive: boolean }) =>
      updateOAuthClient(client.id, { isActive }),
    onSuccess: client => {
      invalidate();
      setDeactivateTarget(null);
      toast.success(`${client.name} ${client.isActive ? 'activated' : 'deactivated'}`);
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const rotateMutation = useMutation({
    mutationFn: (client: OAuthClientView) => rotateOAuthClientSecret(client.id),
    gcTime: 0,
    onSuccess: result => {
      invalidate();
      setRotateTarget(null);
      setSecretResult({ result, rotated: true });
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });

  const openCreate = () => {
    setCreateForm(emptyCreateForm);
    setFormError(null);
    setCreateOpen(true);
  };

  const openEdit = (client: OAuthClientView) => {
    setEditForm(editFormFromClient(client));
    setFormError(null);
    setEditTarget(client);
  };

  const setFederated = (patch: Partial<FederatedForm>) =>
    setCreateForm(f => ({ ...f, federated: { ...f.federated, ...patch } }));

  const setEditFederated = (patch: Partial<FederatedForm>) =>
    setEditForm(f => f && { ...f, federated: { ...f.federated, ...patch } });

  const toggleEditFederated = (enabled: boolean) =>
    setEditForm(
      f =>
        f && {
          ...f,
          federated: { ...f.federated, enabled },
          scopes: enabled ? [...new Set([...f.scopes, ...OAUTH_FEDERATED_DEFAULT_SCOPES])] : f.scopes,
        }
    );

  const toggleEditScope = (scope: string, checked: boolean) =>
    setEditForm(f => f && { ...f, scopes: checked ? [...f.scopes, scope] : f.scopes.filter(s => s !== scope) });

  const saveEdit = () => {
    if (!editTarget || !editForm) return;
    setFormError(null);
    const payload = buildEditPayload(editTarget, editForm);
    if (Object.keys(payload).length === 0) return setEditTarget(null);
    const removed = removedScopes(editTarget, payload);
    const dropsTrust = payload.federatedIdp === null && !!editTarget.federatedIdp;
    if (removed.length || dropsTrust) return setNarrowing({ removed, dropsTrust, payload });
    editMutation.mutate({ client: editTarget, payload });
  };

  const columns: DataColumn<OAuthClientView>[] = [
    {
      id: 'name',
      label: 'Name',
      width: '10rem',
      render: client => (
        <Stack gap={0.5} alignItems="flex-start" sx={{ minWidth: 0 }}>
          <Typography
            level="body-sm"
            fontWeight="lg"
            textColor="text.primary"
            noWrap
            title={client.name}
            sx={{ maxWidth: '100%' }}
            data-testid={`oauth-client-name-${client.clientId}`}
          >
            {client.name}
          </Typography>
          {client.federatedIdp && (
            <Chip size="sm" variant="soft" color="neutral">
              federated
            </Chip>
          )}
        </Stack>
      ),
    },
    {
      id: 'clientId',
      label: 'Client ID',
      width: '14rem',
      render: client => <ClientIdCell clientId={client.clientId} />,
    },
    {
      id: 'type',
      label: 'Type',
      width: '8rem',
      render: client => (
        <Stack gap={0.25} alignItems="flex-start">
          <Chip size="sm" variant="soft" color="neutral">
            {client.clientType}
          </Chip>
          {!isConfidential(client) && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              public (PKCE)
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: 'redirectUris',
      label: 'Redirect URIs',
      render: client => (
        <Stack spacing={0.25} sx={{ minWidth: 0 }}>
          {client.redirectUris.map(uri => (
            <Typography key={uri} level="body-xs" noWrap title={uri} sx={{ fontFamily: 'monospace', maxWidth: '100%' }}>
              {uri}
            </Typography>
          ))}
        </Stack>
      ),
    },
    {
      id: 'scopes',
      label: 'Scopes',
      width: '12rem',
      render: client => (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {client.allowedScopes.map(scope => (
            <Chip key={scope} size="sm" variant="outlined">
              {scope}
            </Chip>
          ))}
        </Stack>
      ),
    },
    {
      id: 'active',
      label: 'Active',
      width: '5rem',
      render: client => (
        <Switch
          size="sm"
          checked={client.isActive}
          disabled={activeMutation.isPending && activeMutation.variables?.client.id === client.id}
          onChange={() =>
            client.isActive ? setDeactivateTarget(client) : activeMutation.mutate({ client, isActive: true })
          }
          slotProps={{ input: { 'data-testid': `oauth-client-toggle-${client.clientId}` } }}
        />
      ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      width: '7rem',
      render: client => (
        <Typography level="body-xs" noWrap sx={client.createdAt ? undefined : { color: 'admin.inkMuted' }}>
          {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : '-'}
        </Typography>
      ),
    },
  ];

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="oauth-clients-tab">
      <AdminPageHeader
        title="OAuth clients"
        count={isPending || (isError && clients.length === 0) ? undefined : clients.length}
        description={
          'Apps registered to use "Sign in with Bike4Mind". Each client authenticates at the token endpoint with its secret, and may only redirect to its registered URIs (exact match).'
        }
        actions={
          <Button size="sm" startDecorator={<AddIcon />} onClick={openCreate} data-testid="oauth-client-add-btn">
            Register client
          </Button>
        }
      />

      {isError && clients.length > 0 && (
        <Alert color="warning" variant="soft" data-testid="oauth-clients-refresh-error">
          {`Could not refresh OAuth clients, showing the last loaded list: ${getErrorMessage(listError)}`}
        </Alert>
      )}

      <DataTable
        label="OAuth clients"
        testId="oauth-clients-table"
        rows={clients}
        columns={columns}
        getRowId={client => client.id}
        rowTestId={client => `oauth-client-row-${client.clientId}`}
        loading={isPending}
        error={
          isError && clients.length === 0 ? `Could not load OAuth clients: ${getErrorMessage(listError)}` : undefined
        }
        onRetry={() => void refetch()}
        empty={
          <Box data-testid="oauth-clients-empty">
            <EmptyState
              title="No OAuth clients registered yet"
              description="Register an app to let it offer Sign in with Bike4Mind."
              action={
                <Button
                  size="sm"
                  variant="outlined"
                  startDecorator={<AddIcon />}
                  onClick={openCreate}
                  data-testid="oauth-clients-empty-add-btn"
                >
                  Register client
                </Button>
              }
            />
          </Box>
        }
        rowActions={client => (
          <ClientRowMenu client={client} onEdit={() => openEdit(client)} onRotate={() => setRotateTarget(client)} />
        )}
        // Fixed columns total 59.5rem; redirect URIs take the rest and truncate. Below 68rem the table
        // scrolls sideways inside its frame.
        minWidth="68rem"
        maxHeight="none"
        pagination={false}
      />

      <AdminDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Register OAuth client"
        width={560}
        data-testid="oauth-client-create-modal"
      >
        <DialogContent>
          <Stack spacing={1.5}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                autoFocus
                placeholder="My App"
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                slotProps={{ input: { 'data-testid': 'oauth-client-name-input' } }}
              />
              <FormHelperText>Shown to users on the consent screen. Must be unique.</FormHelperText>
            </FormControl>

            <FormControl required>
              <FormLabel>Redirect URIs</FormLabel>
              <Textarea
                minRows={2}
                placeholder={'https://app.example.com/callback\nhttps://app.example.com/other'}
                value={createForm.redirectUris}
                onChange={e => setCreateForm(f => ({ ...f, redirectUris: e.target.value }))}
                slotProps={{ textarea: { 'data-testid': 'oauth-client-redirect-uris-input' } }}
              />
              <FormHelperText>
                One absolute URL per line, matched exactly. Must be https; http is allowed only for localhost.
              </FormHelperText>
            </FormControl>

            <Checkbox
              label="First-party client (B4M-owned; receives a full session instead of a scoped token)"
              checked={createForm.firstParty}
              onChange={e => setCreateForm(f => ({ ...f, firstParty: e.target.checked }))}
              slotProps={{ input: { 'data-testid': 'oauth-client-first-party-checkbox' } }}
            />

            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <FormLabel>Federated trust</FormLabel>
                <FormHelperText sx={{ mt: 0 }}>
                  Lets the app mint per-user AI keys via /api/oauth/ai-token.
                </FormHelperText>
              </Box>
              <Switch
                checked={createForm.federated.enabled}
                onChange={e => setFederated({ enabled: e.target.checked })}
                slotProps={{ input: { 'data-testid': 'oauth-client-federated-switch' } }}
              />
            </FormControl>

            {createForm.federated.enabled && (
              <FederatedTrustFields
                value={createForm.federated}
                onChange={setFederated}
                testIdPrefix="oauth-client-federated"
                audiencePlaceholder="Defaults to the new client_id"
              />
            )}

            {createForm.federated.enabled && (
              <UnpaidAccountsToggle
                checked={createForm.unpaidAccountsAllowed}
                onChange={unpaidAccountsAllowed => setCreateForm(f => ({ ...f, unpaidAccountsAllowed }))}
                testid="oauth-client-unpaid-accounts-switch"
              />
            )}

            {formError && (
              <Alert color="danger" variant="soft" data-testid="oauth-client-form-error">
                {formError}
              </Alert>
            )}

            <Stack direction="row" justifyContent="flex-end" spacing={1}>
              <Button variant="plain" color="neutral" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setFormError(null);
                  createMutation.mutate();
                }}
                loading={createMutation.isPending}
                data-testid="oauth-client-create-submit-btn"
              >
                Register client
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </AdminDialog>

      <AdminDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title="Edit OAuth client"
        width={560}
        data-testid="oauth-client-edit-modal"
      >
        <DialogContent>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {editTarget?.name}
          </Typography>
          {editTarget && editForm && (
            <Stack spacing={2}>
              <FormControl required>
                <FormLabel>Redirect URIs</FormLabel>
                <Textarea
                  minRows={3}
                  value={editForm.redirectUris}
                  onChange={e => setEditForm(f => f && { ...f, redirectUris: e.target.value })}
                  slotProps={{ textarea: { 'data-testid': 'oauth-client-edit-uris-input' } }}
                />
                <FormHelperText>One absolute URL per line, matched exactly.</FormHelperText>
              </FormControl>

              <FormControl>
                <FormLabel>Scopes</FormLabel>
                <Stack spacing={0.75}>
                  {[...OAUTH_CLIENT_SCOPES, ...editTarget.allowedScopes.filter(s => !isOAuthClientScope(s))].map(
                    scope => {
                      const checked = editForm.scopes.includes(scope);
                      const optInBlocked =
                        isOptInScope(scope) &&
                        !checked &&
                        !(editForm.federated.enabled && editTarget.clientType === 'relying-party');
                      return (
                        <Checkbox
                          key={scope}
                          label={scope}
                          checked={checked}
                          disabled={scope === 'openid' || optInBlocked}
                          onChange={e => toggleEditScope(scope, e.target.checked)}
                          slotProps={{ input: { 'data-testid': `oauth-client-edit-scope-${scope}` } }}
                        />
                      );
                    }
                  )}
                </Stack>
                <FormHelperText>
                  Opt-in scopes need a federated relying-party client. Removing a scope takes effect for every user of
                  this client.
                </FormHelperText>
              </FormControl>

              <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <FormLabel>Federated trust</FormLabel>
                  <FormHelperText sx={{ mt: 0 }}>
                    Lets the app mint per-user AI keys via /api/oauth/ai-token. Turning it on ticks ai:generate and
                    me:read.
                  </FormHelperText>
                </Box>
                <Switch
                  checked={editForm.federated.enabled}
                  onChange={e => toggleEditFederated(e.target.checked)}
                  slotProps={{ input: { 'data-testid': 'oauth-client-edit-federated-switch' } }}
                />
              </FormControl>

              {editForm.federated.enabled && (
                <FederatedTrustFields
                  value={editForm.federated}
                  onChange={setEditFederated}
                  testIdPrefix="oauth-client-edit-federated"
                  audiencePlaceholder="Defaults to this client_id"
                />
              )}

              {editForm.federated.enabled && (
                <UnpaidAccountsToggle
                  checked={editForm.unpaidAccountsAllowed}
                  onChange={unpaidAccountsAllowed => setEditForm(f => f && { ...f, unpaidAccountsAllowed })}
                  testid="oauth-client-edit-unpaid-accounts-switch"
                />
              )}

              <FormControl>
                <FormLabel>Overwatch product</FormLabel>
                <Input
                  value={editForm.overwatchProductId}
                  placeholder="None"
                  onChange={e => setEditForm(f => f && { ...f, overwatchProductId: e.target.value })}
                  slotProps={{ input: { 'data-testid': 'oauth-client-edit-overwatch-product-input' } }}
                />
                <FormHelperText>
                  An account created to sign in to this client is credited to this Overwatch product, and so are its
                  payments. Empty credits no product.
                </FormHelperText>
              </FormControl>
            </Stack>
          )}
          {formError && (
            <Alert color="danger" variant="soft" data-testid="oauth-client-edit-error">
              {formError}
            </Alert>
          )}
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button loading={editMutation.isPending} onClick={saveEdit} data-testid="oauth-client-edit-save-btn">
              Save changes
            </Button>
          </Stack>
        </DialogContent>
      </AdminDialog>

      <AdminDialog
        open={!!narrowing}
        onClose={() => setNarrowing(null)}
        role="alertdialog"
        title={narrowing?.removed.length ? 'Remove scopes' : 'Turn off federation'}
        data-testid="oauth-client-edit-narrow-modal"
      >
        <DialogContent>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
            {narrowing?.removed.map(scope => (
              <Chip key={scope} size="sm" variant="soft" color="neutral">
                {scope}
              </Chip>
            ))}
          </Stack>
          {!!narrowing?.removed.length && (
            <Typography level="body-sm" sx={{ mt: 1 }}>
              Apps that still request a removed scope get invalid_scope at /authorize, for every user. Grants users
              already approved are kept, but ai-token and federated-admin calls that need a removed scope fail with
              invalid_scope, because the client no longer has it.
            </Typography>
          )}
          {narrowing?.dropsTrust && (
            <Typography level="body-sm" sx={{ mt: 1 }}>
              Removing the trust config stops the AI-token exchange for every user of this client (403).
            </Typography>
          )}
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={() => setNarrowing(null)}>
              Cancel
            </Button>
            <Button
              loading={editMutation.isPending}
              onClick={() =>
                editTarget && narrowing && editMutation.mutate({ client: editTarget, payload: narrowing.payload })
              }
              data-testid="oauth-client-edit-narrow-confirm-btn"
            >
              {narrowing?.removed.length ? 'Remove scopes' : 'Turn off federation'}
            </Button>
          </Stack>
        </DialogContent>
      </AdminDialog>

      {/* Both endpoints are audited but take no reason, so the dialogs collect one without sending it. */}
      <ActionDialog
        open={!!rotateTarget}
        onClose={() => setRotateTarget(null)}
        title="Rotate client secret"
        description={
          <>
            Generate a new secret for <b>{rotateTarget?.name}</b>? The current secret stops working immediately, so the
            app cannot sign users in until it is updated with the new one.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.oauthClientRotate}
        reasonAudited={false}
        tone="danger"
        confirmLabel="Rotate secret"
        pending={rotateMutation.isPending}
        onConfirm={() => {
          if (rotateTarget) rotateMutation.mutate(rotateTarget);
        }}
        data-testid="oauth-client-rotate-modal"
        testIds={{ confirm: 'oauth-client-rotate-confirm-btn' }}
      />

      <ActionDialog
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        title="Deactivate client"
        description={
          <>
            Deactivate <b>{deactivateTarget?.name}</b>? It can no longer start sign-ins or exchange codes for tokens
            until it is reactivated.{' '}
            {deactivateTarget?.clientType === 'first-party'
              ? 'Sessions it already created are not ended.'
              : 'Access tokens it already issued stay valid until they expire.'}{' '}
            Nothing is deleted.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.oauthClientDeactivate}
        reasonAudited={false}
        tone="danger"
        confirmLabel="Deactivate client"
        pending={activeMutation.isPending}
        onConfirm={() => {
          if (deactivateTarget) activeMutation.mutate({ client: deactivateTarget, isActive: false });
        }}
        data-testid="oauth-client-deactivate-modal"
        testIds={{ confirm: 'oauth-client-deactivate-confirm-btn' }}
      />

      {secretResult && (
        <SecretModal
          result={secretResult.result}
          rotated={secretResult.rotated}
          onClose={() => {
            setSecretResult(null);
            createMutation.reset();
            rotateMutation.reset();
          }}
        />
      )}
    </Stack>
  );
}
