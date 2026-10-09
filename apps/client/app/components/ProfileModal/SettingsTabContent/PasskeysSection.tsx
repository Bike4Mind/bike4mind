import React, { useState } from 'react';
import { Box, Button, Card, Chip, Divider, Input, Stack, Typography } from '@mui/joy';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import { toast } from 'sonner';
import {
  describePasskeyError,
  passkeysSupported,
  usePasskeys,
  useRegisterPasskey,
  useRemovePasskey,
} from '@client/app/hooks/data/passkeys';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never';

/**
 * Passkeys as an alternative second factor to the authenticator code. Shown only once MFA is
 * on: the server refuses enrollment otherwise, and disabling MFA removes them.
 */
const PasskeysSection: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { data: passkeys, isLoading } = usePasskeys(enabled);
  const registerPasskey = useRegisterPasskey();
  const removePasskey = useRemovePasskey();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  if (!enabled) return null;

  const supported = passkeysSupported();

  const handleAdd = () => {
    registerPasskey.mutate(
      { name: name.trim() || undefined, token: code },
      {
        onSuccess: passkey => {
          setName('');
          setCode('');
          toast.success(`Added passkey "${passkey.name}"`);
        },
        onError: error => {
          setCode('');
          toast.error(describePasskeyError(error, 'Could not add the passkey'));
        },
      }
    );
  };

  const handleRemove = (id: string, label: string) => {
    removePasskey.mutate(
      { id },
      {
        onSuccess: () => toast.success(`Removed passkey "${label}"`),
        onError: () => toast.error(`Could not remove passkey "${label}"`),
      }
    );
  };

  return (
    <Card variant="outlined" sx={{ p: 3, mt: 2 }} data-testid="passkeys-section">
      <Typography level="h4" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <FingerprintIcon /> Passkeys
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Use Face ID, Touch ID, Windows Hello or a security key instead of typing an authenticator code. Passkeys only
        work on this site, so they cannot be phished. Adding one asks for a current authenticator code.
      </Typography>

      {!supported && (
        <Typography level="body-sm" color="warning" data-testid="passkeys-unsupported">
          This browser does not support passkeys.
        </Typography>
      )}

      {isLoading && <Typography level="body-sm">Loading...</Typography>}

      {!isLoading && (!passkeys || passkeys.length === 0) && (
        <Typography level="body-sm" sx={{ mb: 2 }} data-testid="passkeys-empty">
          No passkeys yet.
        </Typography>
      )}

      {!isLoading && passkeys && passkeys.length > 0 && (
        <Stack spacing={1} divider={<Divider />} sx={{ mb: 2 }}>
          {passkeys.map(passkey => (
            <Box
              key={passkey.id}
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 0.5 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {passkey.name}
                  {passkey.backedUp && (
                    <Chip size="sm" variant="soft">
                      Synced
                    </Chip>
                  )}
                </Typography>
                <Typography level="body-xs">
                  Added {formatDate(passkey.createdAt)} - last used {formatDate(passkey.lastUsedAt)}
                </Typography>
              </Box>
              <Button
                size="sm"
                color="danger"
                variant="outlined"
                data-testid={`passkey-remove-btn-${passkey.id}`}
                loading={removePasskey.isPending && removePasskey.variables?.id === passkey.id}
                onClick={() => handleRemove(passkey.id, passkey.name)}
              >
                Remove
              </Button>
            </Box>
          ))}
        </Stack>
      )}

      {supported && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Input
            size="sm"
            placeholder="Name (e.g. MacBook)"
            value={name}
            onChange={event => setName(event.target.value.slice(0, 64))}
            disabled={registerPasskey.isPending}
            sx={{ flex: 1 }}
            slotProps={{ input: { 'data-testid': 'passkey-name-input', 'aria-label': 'Passkey name' } }}
          />
          <Input
            size="sm"
            placeholder="Authenticator code"
            value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={registerPasskey.isPending}
            sx={{ width: { sm: 170 } }}
            slotProps={{
              input: { 'data-testid': 'passkey-code-input', 'aria-label': 'Authenticator code', inputMode: 'numeric' },
            }}
          />
          <Button
            size="sm"
            data-testid="passkey-add-btn"
            loading={registerPasskey.isPending}
            disabled={code.length !== 6}
            onClick={handleAdd}
          >
            Add a passkey
          </Button>
        </Stack>
      )}
    </Card>
  );
};

export default PasskeysSection;
