import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
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
import { ORG_API_KEY_SCOPES } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import {
  useCreateOrgApiKey,
  useOrgApiKeys,
  useRevokeOrgApiKey,
  useRotateOrgApiKey,
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

/** Shown once, right after a create or rotate: the server never returns the secret again. */
const SecretModal: FC<{ secret: { name: string; key: string } | null; onClose: () => void }> = ({
  secret,
  onClose,
}) => {
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.key);
      toast.success('API key copied');
    } catch {
      toast.error('Could not copy; select the key and copy it manually');
    }
  };

  return (
    // Only Done or the close button dismiss it: a stray Escape or backdrop click would lose the secret.
    <Modal open={!!secret}>
      <ModalDialog sx={{ maxWidth: 560 }} data-testid="org-api-key-secret-modal">
        <ModalClose onClick={onClose} />
        <DialogTitle>Copy your API key</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Alert color="warning" variant="soft">
              This is the only time the key for &quot;{secret?.name}&quot; is shown. Store it somewhere safe now.
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
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresOn, setExpiresOn] = useState('');

  const reset = () => {
    setName('');
    setScopes([]);
    setExpiresOn('');
  };

  const toggleScope = (value: string) =>
    setScopes(current => (current.includes(value) ? current.filter(scope => scope !== value) : [...current, value]));

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    const created = await createKey
      .mutateAsync({
        name: name.trim(),
        scopes,
        ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T23:59:59`).toISOString() } : {}),
      })
      .catch(() => null);
    if (!created) return;
    // Hand the secret to the show-once modal and drop it from the mutation cache.
    createKey.reset();
    close();
    onCreated({ name: created.apiKey.name, key: created.key });
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }} data-testid="org-api-key-create-modal">
        <ModalClose />
        <DialogTitle>New organization API key</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="e.g. Reporting service"
                slotProps={{ input: { maxLength: 100, 'data-testid': 'org-api-key-name-input' } }}
              />
            </FormControl>
            <FormControl required>
              <FormLabel>Scopes</FormLabel>
              <Sheet variant="outlined" sx={{ borderRadius: 'sm', p: 1.5, maxHeight: 240, overflow: 'auto' }}>
                <Stack spacing={1}>
                  {ORG_API_KEY_SCOPES.map(option => (
                    <Checkbox
                      key={option.value}
                      size="sm"
                      label={option.label}
                      checked={scopes.includes(option.value)}
                      onChange={() => toggleScope(option.value)}
                      slotProps={{ input: { 'data-testid': `org-api-key-scope-${option.value}` } }}
                    />
                  ))}
                </Stack>
              </Sheet>
            </FormControl>
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
                loading={createKey.isPending}
                disabled={!name.trim() || scopes.length === 0}
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
const OrgApiKeysSection: FC<OrgApiKeysSectionProps> = ({ organizationId }) => {
  const { data: keys, isLoading, isError } = useOrgApiKeys(organizationId);
  const rotateKey = useRotateOrgApiKey(organizationId);
  const revokeKey = useRevokeOrgApiKey(organizationId);
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const [pending, setPending] = useState<{ action: 'rotate' | 'revoke'; key: IOrgApiKeyView } | null>(null);

  const confirm = async () => {
    if (!pending) return;
    const { action, key } = pending;
    if (action === 'rotate') {
      const rotated = await rotateKey.mutateAsync(key.id).catch(() => null);
      setPending(null);
      rotateKey.reset();
      if (rotated) setSecret({ name: rotated.apiKey.name, key: rotated.key });
      return;
    }
    const revoked = await revokeKey
      .mutateAsync(key.id)
      .then(() => true)
      .catch(() => false);
    setPending(null);
    if (revoked) toast.success(`Revoked "${key.name}"`);
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
          onClick={() => setCreateOpen(true)}
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
          <Table size="sm" data-testid="org-api-keys-table" sx={{ minWidth: 840 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
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
                              onClick={() => setPending({ action: 'rotate', key })}
                              data-testid={`org-api-key-rotate-btn-${key.id}`}
                            >
                              Rotate
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => setPending({ action: 'revoke', key })}
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
      <ConfirmationModal
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        loading={rotateKey.isPending || revokeKey.isPending}
        showToast={false}
        title={pending?.action === 'rotate' ? 'Rotate API key?' : 'Revoke API key?'}
        description={
          pending?.action === 'rotate'
            ? `"${pending.key.name}" gets a new secret and the current one stops working immediately.`
            : `"${pending?.key.name}" stops working immediately. This cannot be undone.`
        }
        confirmText={pending?.action === 'rotate' ? 'Rotate' : 'Revoke'}
        confirmColor={pending?.action === 'rotate' ? 'primary' : 'danger'}
      />
    </Stack>
  );
};

export default OrgApiKeysSection;
