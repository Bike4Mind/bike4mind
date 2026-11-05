import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  LinearProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Table,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import KeyIcon from '@mui/icons-material/VpnKey';
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
};

const emptyCreateForm: CreateForm = {
  name: '',
  redirectUris: '',
  firstParty: false,
  federated: { enabled: false, subjectSource: 'sub', issuer: '', audience: '', providerName: '', jwksUri: '' },
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
  };
}

type EditForm = { redirectUris: string; scopes: string[]; federated: FederatedForm };

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
    <Modal
      open
      onClose={(_event, reason) => {
        if (reason === 'backdropClick' || reason === 'escapeKeyDown') return;
        onClose();
      }}
    >
      <ModalDialog size="lg" sx={{ width: 640, maxWidth: '95vw' }} data-testid="oauth-client-secret-modal">
        <Typography level="h4">{rotated ? 'Client secret rotated' : 'OAuth client registered'}</Typography>
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
      </ModalDialog>
    </Modal>
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

  return (
    <Box sx={{ p: 2 }} data-testid="oauth-clients-tab">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} gap={2}>
        <Box>
          <Typography level="h4">OAuth Clients</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', maxWidth: 620 }}>
            Apps registered to use &quot;Sign in with Bike4Mind&quot;. Each client authenticates at the token endpoint
            with its secret, and may only redirect to its registered URIs (exact match).
          </Typography>
        </Box>
        <Button startDecorator={<AddIcon />} onClick={openCreate} data-testid="oauth-client-add-btn">
          Register client
        </Button>
      </Stack>

      {isPending && <LinearProgress sx={{ mb: 1 }} />}

      {isError && clients.length > 0 && (
        <Alert color="warning" variant="soft" sx={{ mb: 1 }} data-testid="oauth-clients-refresh-error">
          {`Could not refresh OAuth clients, showing the last loaded list: ${getErrorMessage(listError)}`}
        </Alert>
      )}

      {isError && clients.length === 0 ? (
        <Alert color="danger" variant="soft" data-testid="oauth-clients-load-error">
          {`Could not load OAuth clients: ${getErrorMessage(listError)}`}
        </Alert>
      ) : !isPending && clients.length === 0 ? (
        <Sheet variant="soft" sx={{ borderRadius: 'md', py: 6, px: 3, textAlign: 'center' }}>
          <Typography level="title-md" data-testid="oauth-clients-empty">
            No OAuth clients registered yet
          </Typography>
        </Sheet>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table stickyHeader hoverRow sx={{ '--TableCell-headBackground': 'var(--joy-palette-background-level1)' }}>
            <thead>
              <tr>
                <th style={{ width: 160 }}>Name</th>
                <th style={{ width: 240 }}>Client ID</th>
                <th style={{ width: 120 }}>Type</th>
                <th>Redirect URIs</th>
                <th style={{ width: 200 }}>Scopes</th>
                <th style={{ width: 80, textAlign: 'center' }}>Active</th>
                <th style={{ width: 110 }}>Created</th>
                <th style={{ width: 100, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(client => {
                const isConfidential = client.tokenEndpointAuthMethod === 'client_secret_post';
                return (
                  <tr
                    key={client.id}
                    data-testid={`oauth-client-row-${client.clientId}`}
                    style={{ opacity: client.isActive ? 1 : 0.55 }}
                  >
                    <td>
                      <Typography level="body-sm" fontWeight="lg" textColor="text.primary">
                        {client.name}
                      </Typography>
                      {client.federatedIdp && (
                        <Chip size="sm" variant="soft" color="warning">
                          federated
                        </Chip>
                      )}
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {client.clientId}
                      </Typography>
                    </td>
                    <td>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={client.clientType === 'first-party' ? 'primary' : 'neutral'}
                      >
                        {client.clientType}
                      </Chip>
                      {!isConfidential && (
                        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                          public (PKCE)
                        </Typography>
                      )}
                    </td>
                    <td>
                      <Stack spacing={0.25}>
                        {client.redirectUris.map(uri => (
                          <Typography
                            key={uri}
                            level="body-xs"
                            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                          >
                            {uri}
                          </Typography>
                        ))}
                      </Stack>
                    </td>
                    <td>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {client.allowedScopes.map(scope => (
                          <Chip key={scope} size="sm" variant="outlined">
                            {scope}
                          </Chip>
                        ))}
                      </Stack>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Switch
                        size="sm"
                        color={client.isActive ? 'success' : 'neutral'}
                        checked={client.isActive}
                        disabled={activeMutation.isPending && activeMutation.variables?.client.id === client.id}
                        onChange={() =>
                          client.isActive
                            ? setDeactivateTarget(client)
                            : activeMutation.mutate({ client, isActive: true })
                        }
                        slotProps={{ input: { 'data-testid': `oauth-client-toggle-${client.clientId}` } }}
                      />
                    </td>
                    <td>
                      <Typography level="body-xs">
                        {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : '-'}
                      </Typography>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Edit client">
                          <IconButton
                            size="sm"
                            variant="plain"
                            onClick={() => openEdit(client)}
                            data-testid={`oauth-client-edit-${client.clientId}`}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        {isConfidential && (
                          <Tooltip title="Rotate secret">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="warning"
                              onClick={() => setRotateTarget(client)}
                              data-testid={`oauth-client-rotate-${client.clientId}`}
                            >
                              <KeyIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)}>
        <ModalDialog
          sx={{ minWidth: 460, maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}
          data-testid="oauth-client-create-modal"
        >
          <ModalClose />
          <Typography level="h4">Register OAuth client</Typography>
          <Divider sx={{ my: 1 }} />
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
                Register
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={!!editTarget} onClose={() => setEditTarget(null)}>
        <ModalDialog sx={{ minWidth: 460, maxWidth: 560, overflow: 'auto' }} data-testid="oauth-client-edit-modal">
          <ModalClose />
          <Typography level="h4">Edit OAuth client</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {editTarget?.name}
          </Typography>
          <Divider sx={{ my: 1 }} />
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
              Save
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={!!narrowing} onClose={() => setNarrowing(null)}>
        <ModalDialog role="alertdialog" variant="outlined" data-testid="oauth-client-edit-narrow-modal">
          <Typography level="h4" startDecorator={<WarningRoundedIcon sx={{ color: 'warning.500' }} />}>
            {narrowing?.removed.length ? 'Remove scopes' : 'Turn off federation'}
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
            {narrowing?.removed.map(scope => (
              <Chip key={scope} size="sm" variant="soft" color="warning">
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
              color="warning"
              loading={editMutation.isPending}
              onClick={() =>
                editTarget && narrowing && editMutation.mutate({ client: editTarget, payload: narrowing.payload })
              }
              data-testid="oauth-client-edit-narrow-confirm-btn"
            >
              {narrowing?.removed.length ? 'Remove scopes' : 'Turn off federation'}
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={!!rotateTarget} onClose={() => setRotateTarget(null)}>
        <ModalDialog role="alertdialog" variant="outlined" data-testid="oauth-client-rotate-modal">
          <Typography level="h4" startDecorator={<WarningRoundedIcon sx={{ color: 'warning.500' }} />}>
            Rotate client secret
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography level="body-sm">
            Generate a new secret for <b>{rotateTarget?.name}</b>? The current secret stops working immediately, so the
            app cannot sign users in until it is updated with the new one.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={() => setRotateTarget(null)}>
              Cancel
            </Button>
            <Button
              color="warning"
              loading={rotateMutation.isPending}
              onClick={() => rotateTarget && rotateMutation.mutate(rotateTarget)}
              data-testid="oauth-client-rotate-confirm-btn"
            >
              Rotate secret
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <Modal open={!!deactivateTarget} onClose={() => setDeactivateTarget(null)}>
        <ModalDialog role="alertdialog" variant="outlined" data-testid="oauth-client-deactivate-modal">
          <Typography level="h4" startDecorator={<WarningRoundedIcon sx={{ color: 'danger.500' }} />}>
            Deactivate client
          </Typography>
          <Divider sx={{ my: 1 }} />
          <Typography level="body-sm">
            Deactivate <b>{deactivateTarget?.name}</b>? It can no longer start sign-ins or exchange codes for tokens
            until it is reactivated.{' '}
            {deactivateTarget?.clientType === 'first-party'
              ? 'Sessions it already created are not ended.'
              : 'Access tokens it already issued stay valid until they expire.'}{' '}
            Nothing is deleted.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={() => setDeactivateTarget(null)}>
              Cancel
            </Button>
            <Button
              color="danger"
              loading={activeMutation.isPending}
              onClick={() => deactivateTarget && activeMutation.mutate({ client: deactivateTarget, isActive: false })}
              data-testid="oauth-client-deactivate-confirm-btn"
            >
              Deactivate
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

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
    </Box>
  );
}
