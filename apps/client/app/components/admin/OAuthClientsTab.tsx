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
import type { CreateOAuthClientInput, OAuthClientView, OAuthClientWithSecret } from '@bike4mind/common';
import {
  fetchOAuthClients,
  createOAuthClient,
  updateOAuthClient,
  rotateOAuthClientSecret,
} from '@client/app/utils/oauthClientAPICalls';
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

export function buildCreatePayload(form: CreateForm): CreateOAuthClientInput {
  const { federated } = form;
  return {
    name: form.name,
    redirectUris: parseUris(form.redirectUris),
    clientType: form.firstParty ? 'first-party' : 'relying-party',
    ...(federated.enabled
      ? {
          federatedIdp: {
            subjectSource: federated.subjectSource,
            issuer: blankToUndefined(federated.issuer),
            audience: blankToUndefined(federated.audience),
            jwksUri: blankToUndefined(federated.jwksUri),
            ...(federated.subjectSource === 'identities'
              ? { providerName: blankToUndefined(federated.providerName) }
              : {}),
          },
        }
      : {}),
  };
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
  const [editUris, setEditUris] = useState('');
  const [rotateTarget, setRotateTarget] = useState<OAuthClientView | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<OAuthClientView | null>(null);
  // The secret is held in state and in the create/rotate mutation result; both are cleared when the modal closes (gcTime 0).
  const [secretResult, setSecretResult] = useState<{ result: OAuthClientWithSecret; rotated: boolean } | null>(null);

  const { data: clients = [], isPending } = useQuery({ queryKey: [QUERY_KEY], queryFn: fetchOAuthClients });
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
    mutationFn: (client: OAuthClientView) => updateOAuthClient(client.id, { redirectUris: parseUris(editUris) }),
    onSuccess: client => {
      invalidate();
      setEditTarget(null);
      toast.success(`Updated redirect URIs for ${client.name}`);
    },
    onError: (error: unknown) => setFormError(getErrorMessage(error)),
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
    setEditUris(client.redirectUris.join('\n'));
    setFormError(null);
    setEditTarget(client);
  };

  const setFederated = (patch: Partial<FederatedForm>) =>
    setCreateForm(f => ({ ...f, federated: { ...f.federated, ...patch } }));

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

      {!isPending && clients.length === 0 ? (
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
                        <Tooltip title="Edit redirect URIs">
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
                  Lets the app mint per-user AI keys via /api/oauth/ai-token. Cannot be added later.
                </FormHelperText>
              </Box>
              <Switch
                checked={createForm.federated.enabled}
                onChange={e => setFederated({ enabled: e.target.checked })}
                slotProps={{ input: { 'data-testid': 'oauth-client-federated-switch' } }}
              />
            </FormControl>

            {createForm.federated.enabled && (
              <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm' }}>
                <Stack spacing={1.25}>
                  <FormControl>
                    <FormLabel>Subject source</FormLabel>
                    <Select
                      value={createForm.federated.subjectSource}
                      onChange={(_e, value) => value && setFederated({ subjectSource: value })}
                      data-testid="oauth-client-federated-subject-select"
                    >
                      <Option value="sub">sub - app signs in against B4M directly</Option>
                      <Option value="identities">identities - app&apos;s Cognito pool federates B4M</Option>
                    </Select>
                  </FormControl>
                  <FormControl required>
                    <FormLabel>Issuer</FormLabel>
                    <Input
                      value={createForm.federated.issuer}
                      onChange={e => setFederated({ issuer: e.target.value })}
                      slotProps={{ input: { 'data-testid': 'oauth-client-federated-issuer-input' } }}
                    />
                  </FormControl>
                  <FormControl required={createForm.federated.subjectSource === 'identities'}>
                    <FormLabel>Audience</FormLabel>
                    <Input
                      placeholder={createForm.federated.subjectSource === 'sub' ? 'Defaults to the new client_id' : ''}
                      value={createForm.federated.audience}
                      onChange={e => setFederated({ audience: e.target.value })}
                      slotProps={{ input: { 'data-testid': 'oauth-client-federated-audience-input' } }}
                    />
                  </FormControl>
                  {createForm.federated.subjectSource === 'identities' && (
                    <FormControl required>
                      <FormLabel>Provider name</FormLabel>
                      <Input
                        value={createForm.federated.providerName}
                        onChange={e => setFederated({ providerName: e.target.value })}
                        slotProps={{ input: { 'data-testid': 'oauth-client-federated-provider-input' } }}
                      />
                    </FormControl>
                  )}
                  <FormControl required={createForm.federated.subjectSource === 'sub'}>
                    <FormLabel>JWKS URI</FormLabel>
                    <Input
                      placeholder={
                        createForm.federated.subjectSource === 'sub'
                          ? '<issuer>/api/oauth/jwks'
                          : 'Defaults to <issuer>/.well-known/jwks.json'
                      }
                      value={createForm.federated.jwksUri}
                      onChange={e => setFederated({ jwksUri: e.target.value })}
                      slotProps={{ input: { 'data-testid': 'oauth-client-federated-jwks-input' } }}
                    />
                  </FormControl>
                </Stack>
              </Sheet>
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
        <ModalDialog sx={{ minWidth: 460, maxWidth: 560 }} data-testid="oauth-client-edit-modal">
          <ModalClose />
          <Typography level="h4">Edit redirect URIs</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {editTarget?.name}
          </Typography>
          <Divider sx={{ my: 1 }} />
          <FormControl required>
            <Textarea
              minRows={3}
              value={editUris}
              onChange={e => setEditUris(e.target.value)}
              slotProps={{ textarea: { 'data-testid': 'oauth-client-edit-uris-input' } }}
            />
            <FormHelperText>One absolute URL per line, matched exactly.</FormHelperText>
          </FormControl>
          {formError && (
            <Alert color="danger" variant="soft" data-testid="oauth-client-edit-error">
              {formError}
            </Alert>
          )}
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              loading={editMutation.isPending}
              onClick={() => {
                setFormError(null);
                if (editTarget) editMutation.mutate(editTarget);
              }}
              data-testid="oauth-client-edit-save-btn"
            >
              Save
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
