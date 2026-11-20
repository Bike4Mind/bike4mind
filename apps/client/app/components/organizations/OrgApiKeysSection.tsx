import { FC, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import { ApiKeyStatus, type IOrgApiKeyView } from '@bike4mind/common';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';
import {
  EditOrgApiKeyAccessModal,
  OrgApiKeyAccessFields,
  accessValueOf,
  describeReach,
  isAccessComplete,
} from './OrgApiKeyAccessFields';
import {
  useCreateOrgApiKey,
  useOrgApiKeyOptions,
  useOrgApiKeys,
  useRevokeOrgApiKey,
  useRotateOrgApiKey,
  useRotateOrgApiKeyCallbackSecret,
} from '@client/app/hooks/data/orgApiKeys';
import { toast } from 'sonner';
import { STATUS_LABEL, effectiveStatus, formatDate } from './orgApiKeyDisplay';

interface OrgApiKeysSectionProps {
  organizationId: string;
}

const todayLocal = (): string => {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const CONFIRM_COPY = {
  rotate: {
    title: 'Rotate API key?',
    description: (name: string) => `"${name}" gets a new secret and the current one stops working immediately.`,
    confirmText: 'Rotate',
  },
  revoke: {
    title: 'Revoke API key?',
    description: (name: string) => `"${name}" stops working immediately. This cannot be undone.`,
    confirmText: 'Revoke',
  },
  'callback-secret': {
    title: 'Generate a new callback signing secret?',
    description: (name: string) =>
      `Generation callbacks for "${name}" will be signed with a new secret. Any previous secret stops verifying on the next delivery.`,
    confirmText: 'Generate secret',
  },
} as const;

/** Owns one request until settlement, and rejects completions after its scope unmounts. */
const useKeyRequest = () => {
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    pending,
    isPending: () => inFlight.current,
    isCurrent: () => mounted.current,
    start: () => {
      if (!mounted.current || inFlight.current) return false;
      inFlight.current = true;
      setPending(true);
      return true;
    },
    finish: () => {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    },
  };
};

/** Shown once, right after a create or rotate: the server never returns the secret again. */
type ShownSecret = { name: string; key: string; kind?: 'key' | 'callback' };

const SecretModal: FC<{ secret: ShownSecret | null; onClose: () => void }> = ({ secret, onClose }) => {
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.key);
      toast.success(secret.kind === 'callback' ? 'Callback signing secret copied' : 'API key copied');
    } catch {
      toast.error(
        secret.kind === 'callback'
          ? 'Could not copy; select the callback signing secret and copy it manually'
          : 'Could not copy; select the API key and copy it manually'
      );
    }
  };

  return (
    // Only Done or the close button dismiss it: a stray Escape or backdrop click would lose the secret.
    <Modal open={!!secret}>
      <ModalDialog sx={{ maxWidth: 560 }} data-testid="org-api-key-secret-modal">
        <ModalClose aria-label="Close" onClick={onClose} />
        <DialogTitle>
          {secret?.kind === 'callback' ? 'Copy your callback signing secret' : 'Copy your API key'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Alert color="warning" variant="soft">
              This is the only time the {secret?.kind === 'callback' ? 'callback signing secret' : 'key'} for &quot;
              {secret?.name}&quot; is shown. Store it somewhere safe now.
            </Alert>
            <Input
              readOnly
              value={secret?.key ?? ''}
              slotProps={{ input: { 'data-testid': 'org-api-key-secret-value' } }}
              endDecorator={
                <Button
                  size="sm"
                  variant="soft"
                  startDecorator={<ContentCopyIcon />}
                  onClick={copy}
                  data-testid="org-api-key-copy-btn"
                >
                  Copy
                </Button>
              }
            />
            <Box display="flex" justifyContent="flex-end">
              <Button onClick={onClose} data-testid="org-api-key-secret-done-btn">
                Done
              </Button>
            </Box>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

const CreateKeyModal: FC<{
  open: boolean;
  onClose: () => void;
  organizationId: string;
  onCreated: (secret: { name: string; key: string }) => void;
}> = ({ open, onClose, organizationId, onCreated }) => {
  const createKey = useCreateOrgApiKey(organizationId);
  const request = useKeyRequest();
  const [name, setName] = useState('');
  const [access, setAccess] = useState(() => accessValueOf([], []));
  const [expiresOn, setExpiresOn] = useState('');

  const reset = () => {
    setName('');
    setAccess(accessValueOf([], []));
    setExpiresOn('');
  };

  const close = () => {
    if (request.isPending()) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!request.start()) return;
    try {
      const created = await createKey.mutateAsync({
        name: name.trim(),
        scopes: access.scopes,
        grants: access.grants,
        ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T23:59:59`).toISOString() } : {}),
      });
      if (!request.isCurrent()) return;
      reset();
      onClose();
      onCreated({ name: created.apiKey.name, key: created.key });
    } catch {
      // The mutation reports the error; keep the form and its draft available for retry.
    } finally {
      // Detach this observer even if the owner unmounted; gcTime:0 removes the secret result.
      createKey.reset();
      request.finish();
    }
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }} data-testid="org-api-key-create-modal">
        <ModalClose aria-label="Close" />
        <DialogTitle>New organization API key</DialogTitle>
        <DialogContent>
          <Stack
            component="fieldset"
            disabled={request.pending}
            spacing={2}
            sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}
          >
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="e.g. Reporting service"
                slotProps={{ input: { maxLength: 100, 'data-testid': 'org-api-key-name-input' } }}
              />
            </FormControl>
            {open && <OrgApiKeyAccessFields organizationId={organizationId} value={access} onChange={setAccess} />}
            <FormControl>
              <FormLabel>Expires on</FormLabel>
              <Input
                type="date"
                value={expiresOn}
                onChange={event => setExpiresOn(event.target.value)}
                slotProps={{ input: { min: todayLocal(), 'data-testid': 'org-api-key-expiry-input' } }}
              />
              <FormHelperText>Optional. Leave empty for a key that does not expire.</FormHelperText>
            </FormControl>
            <Box display="flex" justifyContent="flex-end" gap={1}>
              <Button variant="plain" color="neutral" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                loading={request.pending}
                disabled={!name.trim() || !isAccessComplete(access)}
                data-testid="org-api-key-create-submit-btn"
              >
                Create key
              </Button>
            </Box>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

/**
 * Org-owned API keys: held by the organization rather than a member, billed to the org, and unaffected by
 * any member leaving. Owner, managers and platform admins (the same gate as the routes, verifyOrgAccess).
 */
const OrgApiKeysContent: FC<OrgApiKeysSectionProps> = ({ organizationId }) => {
  const request = useKeyRequest();
  const { data: keys, isLoading, isError } = useOrgApiKeys(organizationId);
  const rotateKey = useRotateOrgApiKey(organizationId);
  const revokeKey = useRevokeOrgApiKey(organizationId);
  const { data: options } = useOrgApiKeyOptions(organizationId);
  const groupNames = options ? new Map(options.groups.map(group => [group.id, group.name])) : undefined;
  const [createOpen, setCreateOpen] = useState(false);
  const rotateCallbackSecret = useRotateOrgApiKeyCallbackSecret(organizationId);
  const [secret, setSecret] = useState<ShownSecret | null>(null);
  const [pending, setPending] = useState<{
    action: 'rotate' | 'revoke' | 'callback-secret';
    key: IOrgApiKeyView;
  } | null>(null);
  const [editing, setEditing] = useState<IOrgApiKeyView | null>(null);

  const openAction = (action: 'rotate' | 'revoke' | 'callback-secret', key: IOrgApiKeyView) => {
    if (!request.isPending()) setPending({ action, key });
  };
  const closeAction = () => {
    if (!request.isPending()) setPending(null);
  };
  const confirm = async () => {
    if (!pending || !request.start()) return;
    const { action, key } = pending;
    try {
      if (action === 'rotate') {
        const rotated = await rotateKey.mutateAsync(key.id);
        if (!request.isCurrent()) return;
        setPending(null);
        setSecret({ name: rotated.apiKey.name, key: rotated.key });
      } else if (action === 'callback-secret') {
        const minted = await rotateCallbackSecret.mutateAsync(key.id);
        if (!request.isCurrent()) return;
        setPending(null);
        setSecret({ name: minted.name, key: minted.callbackSigningSecret, kind: 'callback' });
      } else {
        await revokeKey.mutateAsync(key.id);
        if (!request.isCurrent()) return;
        setPending(null);
        toast.success(`Revoked "${key.name}"`);
      }
    } catch {
      // The mutation reports the error; retain this confirmation so the same action can be retried.
    } finally {
      if (action === 'rotate') rotateKey.reset();
      if (action === 'callback-secret') rotateCallbackSecret.reset();
      request.finish();
    }
  };

  return (
    <Stack spacing={2} data-testid="org-api-keys-section">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Typography level="body-sm" color="neutral">
          Keys owned by the organization, not by a member. Usage is billed to the organization, and the keys keep
          working when any member, including the one who created them, leaves the organization.
        </Typography>
        <Button
          startDecorator={<AddIcon />}
          onClick={() => {
            if (!request.isPending()) setCreateOpen(true);
          }}
          disabled={request.pending}
          sx={{ flexShrink: 0 }}
          data-testid="org-api-key-new-btn"
        >
          New key
        </Button>
      </Stack>

      {isLoading && <CircularProgress size="sm" />}
      {isError && (
        <Alert color="danger" variant="soft">
          Failed to load the organization&apos;s API keys.
        </Alert>
      )}
      {keys && keys.length === 0 && (
        <Typography level="body-sm" data-testid="org-api-keys-empty">
          No organization API keys yet.
        </Typography>
      )}
      {keys && keys.length > 0 && (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table size="sm" data-testid="org-api-keys-table" sx={{ minWidth: 960 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Access</th>
                <th>Created by</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const status = effectiveStatus(key);
                const active = status === ApiKeyStatus.ACTIVE;
                const revocable = active || status === ApiKeyStatus.EXPIRED;
                return (
                  <tr key={key.id} data-testid={`org-api-key-row-${key.id}`}>
                    <td>{key.name}</td>
                    <td>
                      <Typography level="body-xs" fontFamily="code">
                        {key.keyPrefix}...
                      </Typography>
                    </td>
                    <td>
                      <Stack direction="row" flexWrap="wrap" gap={0.5}>
                        {key.scopes.map(scope => (
                          <Chip key={scope} size="sm" variant="soft">
                            {scope}
                          </Chip>
                        ))}
                      </Stack>
                    </td>
                    <td data-testid={`org-api-key-reach-${key.id}`}>{describeReach(key.grants, groupNames)}</td>
                    <td>{key.createdBy ? (key.createdBy.name ?? 'Deleted user') : '\u2014'}</td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</td>
                    <td>{key.expiresAt ? formatDate(key.expiresAt) : 'Never'}</td>
                    <td>
                      <Chip size="sm" variant="soft" color={STATUS_LABEL[status].color}>
                        {STATUS_LABEL[status].label}
                      </Chip>
                    </td>
                    <td>
                      {revocable && (
                        <Stack direction="row" gap={0.5} justifyContent="flex-end">
                          {active && (
                            <Button
                              size="sm"
                              variant="plain"
                              onClick={() => {
                                if (!request.isPending()) setEditing(key);
                              }}
                              disabled={request.pending}
                              data-testid={`org-api-key-edit-btn-${key.id}`}
                            >
                              Edit access
                            </Button>
                          )}
                          {active && (
                            <Button
                              size="sm"
                              variant="plain"
                              onClick={() => openAction('rotate', key)}
                              disabled={request.pending}
                              data-testid={`org-api-key-rotate-btn-${key.id}`}
                            >
                              Rotate
                            </Button>
                          )}
                          {active && (
                            <Button
                              size="sm"
                              variant="plain"
                              onClick={() => openAction('callback-secret', key)}
                              disabled={request.pending}
                              data-testid={`org-api-key-callback-secret-btn-${key.id}`}
                            >
                              Callback secret
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => openAction('revoke', key)}
                            disabled={request.pending}
                            data-testid={`org-api-key-revoke-btn-${key.id}`}
                          >
                            Revoke
                          </Button>
                        </Stack>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      <CreateKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        organizationId={organizationId}
        onCreated={setSecret}
      />
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
      <EditOrgApiKeyAccessModal organizationId={organizationId} apiKey={editing} onClose={() => setEditing(null)} />
      <ConfirmationModal
        open={!!pending}
        onClose={closeAction}
        onConfirm={confirm}
        loading={request.pending}
        showToast={false}
        title={CONFIRM_COPY[pending?.action ?? 'revoke'].title}
        description={pending ? CONFIRM_COPY[pending.action].description(pending.key.name) : ''}
        confirmText={CONFIRM_COPY[pending?.action ?? 'revoke'].confirmText}
        confirmColor={pending?.action === 'revoke' ? 'danger' : 'primary'}
      />
    </Stack>
  );
};

// A scope change discards every old-org modal and request owner, including A → B → A navigation.
const OrgApiKeysSection: FC<OrgApiKeysSectionProps> = ({ organizationId }) => (
  <OrgApiKeysContent key={organizationId} organizationId={organizationId} />
);

export default OrgApiKeysSection;
