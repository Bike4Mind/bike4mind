import React from 'react';
import { Box, Button, Card, Chip, Divider, Stack, Typography } from '@mui/joy';
import DevicesIcon from '@mui/icons-material/Devices';
import { toast } from 'sonner';
import {
  useTrustedDevices,
  useRevokeAllTrustedDevices,
  useRevokeTrustedDevice,
} from '@client/app/hooks/data/trustedDevices';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never';

/**
 * Revocation surface for "remember this device" grants. Until per-device logout
 * (active sessions) lands this is the only place a user can drop a trust, so it is
 * shown whenever MFA is on - including when the list is empty.
 */
const TrustedDevicesSection: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { data: devices, isLoading } = useTrustedDevices(enabled);
  const revokeOne = useRevokeTrustedDevice();
  const revokeAll = useRevokeAllTrustedDevices();

  if (!enabled) return null;

  const handleRevokeOne = (id: string, label: string) => {
    revokeOne.mutate(
      { id },
      {
        onSuccess: () => toast.success(`Removed ${label}`),
        onError: () => toast.error(`Could not remove ${label}`),
      }
    );
  };

  const handleRevokeAll = () => {
    revokeAll.mutate(undefined, {
      onSuccess: ({ revoked }) =>
        toast.success(revoked > 0 ? `Removed ${revoked} trusted device(s)` : 'No trusted devices to remove'),
      onError: () => toast.error('Could not remove trusted devices'),
    });
  };

  return (
    <Card variant="outlined" sx={{ p: 3, mt: 2 }} data-testid="trusted-devices-section">
      <Typography level="h4" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <DevicesIcon /> Trusted Devices
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Devices that skip the authenticator code when you sign in. A one-time code is still emailed every time. Remove
        any device you no longer use or recognize.
      </Typography>

      {isLoading && <Typography level="body-sm">Loading...</Typography>}

      {!isLoading && (!devices || devices.length === 0) && (
        <Typography level="body-sm" data-testid="trusted-devices-empty">
          No trusted devices. You can add one from the &quot;Remember this device&quot; option when you sign in.
        </Typography>
      )}

      {!isLoading && devices && devices.length > 0 && (
        <Stack spacing={1} divider={<Divider />}>
          {devices.map(device => (
            <Box
              key={device.id}
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 0.5 }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography level="body-md" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {device.label}
                  {device.isCurrent && (
                    <Chip size="sm" color="primary" variant="soft">
                      This device
                    </Chip>
                  )}
                </Typography>
                <Typography level="body-xs">
                  Last used {formatDate(device.lastUsedAt)} - expires {formatDate(device.expiresAt)}
                </Typography>
              </Box>
              <Button
                size="sm"
                color="danger"
                variant="outlined"
                data-testid={`trusted-device-revoke-btn-${device.id}`}
                loading={revokeOne.isPending && revokeOne.variables?.id === device.id}
                onClick={() => handleRevokeOne(device.id, device.label)}
              >
                Remove
              </Button>
            </Box>
          ))}

          <Button
            size="sm"
            color="danger"
            variant="soft"
            data-testid="trusted-devices-revoke-all-btn"
            loading={revokeAll.isPending}
            onClick={handleRevokeAll}
          >
            Remove all trusted devices
          </Button>
        </Stack>
      )}
    </Card>
  );
};

export default TrustedDevicesSection;
