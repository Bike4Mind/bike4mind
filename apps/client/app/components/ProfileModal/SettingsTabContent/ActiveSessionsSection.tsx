import React, { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import DevicesIcon from '@mui/icons-material/Devices';
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import LogoutIcon from '@mui/icons-material/Logout';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useGetActiveSessions, useLogoutAllDevices, useRevokeSession } from '@client/app/hooks/data/user';
import { describeUserAgent } from '@client/app/utils/describeUserAgent';

// fromNow() needs the relativeTime plugin; extend is idempotent so this is safe even if another
// module already registered it.
dayjs.extend(relativeTime);

const isMobileOs = (os: string): boolean => os === 'iPhone' || os === 'iPad' || os === 'Android';

const ActiveSessionsSection: React.FC = () => {
  const { data: sessions, isLoading, isError } = useGetActiveSessions();
  const revokeSession = useRevokeSession();
  const logoutAll = useLogoutAllDevices();
  // Mirror the ProfileMenu logout guard: while impersonating, the "all devices" panic lever bumps
  // the real customer's tokenVersion, so the server refuses it (403) and we hide it here too.
  const impersonating = useAccessToken(s => s.impersonating);

  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  return (
    <Box
      data-testid="active-sessions-section"
      sx={theme => ({ ...cardSurfaceSx(theme), display: 'flex', flexDirection: 'column', gap: '16px' })}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <DevicesIcon sx={{ fontSize: '18px', opacity: 0.7 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
            Active Sessions
          </Typography>
          <Typography level="body-sm" sx={{ mt: 0.5 }}>
            Devices signed in to your account. Sign out any you don&apos;t recognize.
          </Typography>
        </Box>
      </Box>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size="sm" />
        </Box>
      )}

      {isError && !isLoading && (
        <Alert color="danger" variant="soft">
          Could not load your active sessions. Please try again.
        </Alert>
      )}

      {!isLoading && !isError && sessions && (
        <Stack data-testid="active-sessions-list" spacing={1}>
          {sessions.length === 0 && (
            <Typography level="body-sm" sx={{ opacity: 0.7 }}>
              No active sessions.
            </Typography>
          )}
          {sessions.map((session, index) => {
            const { os, label } = describeUserAgent(session.device?.userAgent);
            const DeviceIcon = isMobileOs(os) ? PhoneIphoneIcon : DesktopWindowsIcon;
            const metaParts = [
              `Last active ${dayjs(session.lastUsedAt).fromNow()}`,
              ...(session.device?.ip ? [session.device.ip] : []),
            ];
            return (
              <Box
                key={session.sid}
                data-testid={`active-session-${index}`}
                sx={theme => ({
                  ...cardSurfaceSx(theme),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px',
                })}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flex: 1, minWidth: 0 }}>
                  <DeviceIcon sx={{ fontSize: '20px', opacity: 0.6, flexShrink: 0 }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                      <Typography level="body-md" sx={{ fontWeight: 500 }}>
                        {label}
                      </Typography>
                      {session.current && (
                        <Chip size="sm" color="success" variant="soft" data-testid={`active-session-current-${index}`}>
                          This device
                        </Chip>
                      )}
                      {session.impersonated && (
                        <Chip size="sm" color="warning" variant="soft">
                          Impersonated
                        </Chip>
                      )}
                    </Stack>
                    <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                      {metaParts.join(' \u00B7 ')}
                    </Typography>
                  </Box>
                </Box>
                {!session.current && (
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    data-testid={`active-session-revoke-${index}`}
                    loading={revokeSession.isPending && revokeSession.variables === session.sid}
                    disabled={revokeSession.isPending}
                    onClick={() => revokeSession.mutate(session.sid)}
                  >
                    Sign out
                  </Button>
                )}
              </Box>
            );
          })}
        </Stack>
      )}

      {!impersonating && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            variant="soft"
            color="danger"
            startDecorator={<LogoutIcon />}
            data-testid="logout-all-devices-btn"
            loading={logoutAll.isPending}
            onClick={() => setConfirmAllOpen(true)}
          >
            Log out all devices
          </Button>
        </Box>
      )}

      {confirmAllOpen && (
        <ConfirmActionModal
          data-testid="logout-all-confirm-modal"
          title="Log out all devices?"
          description="This signs you out everywhere, including this device. You'll need to sign in again. Use this if you think someone else has access to your account."
          forwardButtonText="Log out everywhere"
          backwardButtonText="Cancel"
          loading={logoutAll.isPending}
          onGoBackward={() => setConfirmAllOpen(false)}
          onGoForward={() => logoutAll.mutate()}
        />
      )}
    </Box>
  );
};

export default ActiveSessionsSection;
