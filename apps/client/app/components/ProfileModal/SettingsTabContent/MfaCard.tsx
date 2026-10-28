import { useState } from 'react';
import { Alert, Box, Button, Grid, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import {
  useMFAStatus,
  useSetupMFA,
  useVerifyMFASetup,
  useCancelMFASetup,
  useDisableMFA,
  useRegenerateBackupCodes,
} from '@client/app/hooks/data/mfa';
import MFAModal from '@client/app/components/common/MFAModal';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useUser } from '@client/app/contexts/UserContext';
import PasskeysSection from './PasskeysSection';
import TrustedDevicesSection from './TrustedDevicesSection';
import SettingsActionButton from './SettingsActionButton';

/**
 * The Security section's MFA card plus the sections gated on it (Passkeys, Trusted Devices),
 * with the enable/disable/regenerate flows and their modals.
 */
const MfaCard = () => {
  const { refreshUser } = useUser();
  const queryClient = useQueryClient();
  // MFA enforcement is a settings-map value; until the authenticated fetch lands we do not know
  // whether the user may disable, so Disable stays hidden (and stays hidden if that fetch fails)
  // rather than appearing and vanishing, or showing for an enforced org.
  const { settings: adminSettings, authedSettingsLoaded } = useAdminSettings();
  const mfaEnforced = adminSettings?.enforceMFA === 'true';
  const { data: mfaStatus } = useMFAStatus();
  const setupMFA = useSetupMFA();
  const verifyMFASetup = useVerifyMFASetup();
  const cancelMFASetup = useCancelMFASetup();
  const disableMFA = useDisableMFA();
  const regenerateBackupCodes = useRegenerateBackupCodes();

  const [showMFAModal, setShowMFAModal] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState<string[] | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  const handleEnableMFA = () => {
    setupMFA.mutate(undefined, {
      onSuccess: () => {
        setShowMFAModal(true);
        toast.success('MFA setup initiated');
      },
      onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
        if (isStepUpCancelled(error)) return;
        const errorMessage = error.response?.data?.error || error.message || 'Failed to setup MFA';
        toast.error(errorMessage);
      },
    });
  };

  const handleMFAVerification = (token: string) => {
    verifyMFASetup.mutate(
      { token },
      {
        onSuccess: (data: { backupCodes?: string[] }) => {
          setShowMFAModal(false);
          if (data.backupCodes) {
            setShowBackupCodes(data.backupCodes);
          }
          toast.success('MFA enabled successfully');
          // The status query drives this card and the Passkeys/Trusted Devices sections, and
          // refetchOnWindowFocus is off, so enable/disable/regenerate all refresh it here.
          queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
          refreshUser();
          queryClient.invalidateQueries({ queryKey: ['identify'] });
          queryClient.invalidateQueries({ queryKey: ['users'] });
        },
        onError: (error: {
          response?: { data?: { error?: string; attemptsRemaining?: number } };
          message?: string;
        }) => {
          const errorData = error.response?.data;
          const baseError = errorData?.error || error.message || 'MFA verification failed';
          const attemptsInfo = errorData?.attemptsRemaining
            ? ` (${errorData.attemptsRemaining} attempts remaining)`
            : '';
          toast.error(baseError + attemptsInfo);
        },
      }
    );
  };

  const handleCancelSetup = () => {
    cancelMFASetup.mutate(undefined, {
      onSuccess: () => {
        setShowMFAModal(false);
        toast.info('MFA setup cancelled');
      },
    });
  };

  // Both MFA mutations sit behind the server's step-up gate, so a dismissed verification
  // prompt is an expected outcome, not a failure - it must not surface as an error toast.
  const confirmDisableMFA = () => {
    setShowDisableConfirm(false);
    disableMFA.mutate(undefined, {
      onSuccess: () => {
        toast.success('MFA disabled successfully');
        // Disabling flips both this card and the Passkeys/Trusted Devices sections, and the
        // admin Users badge, so refresh the same caches the enable handler does.
        queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: ['identify'] });
        queryClient.invalidateQueries({ queryKey: ['users'] });
      },
      onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
        if (isStepUpCancelled(error)) return;
        toast.error(error.response?.data?.error || error.message || 'Failed to disable MFA');
      },
    });
  };

  const confirmRegenerateBackupCodes = () => {
    setShowRegenerateConfirm(false);
    regenerateBackupCodes.mutate(undefined, {
      onSuccess: (data: { backupCodes?: string[] }) => {
        // Regenerating leaves totpEnabled alone, so only the code count and the auth
        // cache change - the admin Users badge does not need invalidating here.
        queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: ['identify'] });
        // The old codes are already invalid by now, so a response with no codes must not read as success.
        if (!data.backupCodes?.length) {
          toast.error('New backup codes were created but could not be shown. Generate them again.');
          return;
        }
        setShowBackupCodes(data.backupCodes);
        toast.success('New backup codes generated successfully. Save them now!');
      },
      onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
        if (isStepUpCancelled(error)) return;
        toast.error(error.response?.data?.error || error.message || 'Failed to regenerate backup codes');
      },
    });
  };

  return (
    <>
      <Grid container spacing={2}>
        <Grid xs={12} md={6}>
          <Box
            sx={theme => ({
              ...cardSurfaceSx(theme),
              display: 'flex',
              alignItems: 'center',
              // wrap the trailing controls below the title when the row is too
              // narrow, instead of squeezing them until their labels overlap.
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '12px',
              height: '100%',
            })}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                Multi-Factor Authentication
              </Typography>
              <Typography level="body-sm" sx={{ mt: 0.5 }}>
                Status:{' '}
                {mfaStatus?.enabled ? (
                  <span style={{ color: 'green', fontWeight: 'bold' }}>Enabled</span>
                ) : (
                  <span style={{ color: 'orange', fontWeight: 'bold' }}>Disabled</span>
                )}
                {mfaEnforced && mfaStatus?.enabled && (
                  <span style={{ color: 'orange', fontWeight: 'normal', marginLeft: '8px' }}>
                    (Required by administrator)
                  </span>
                )}
              </Typography>
            </Box>
            <Box
              sx={{
                display: 'flex',
                gap: 1.5,
                alignItems: 'center',
                flexShrink: 0,
                flexWrap: 'wrap',
                // when the group wraps to its own line, the parent's
                // space-between collapses to flex-start for a single item - ml:auto
                // keeps it right-aligned; maxWidth prevents overflow on very narrow widths.
                justifyContent: 'flex-end',
                ml: 'auto',
                maxWidth: '100%',
              }}
            >
              {!mfaStatus?.enabled && (
                <SettingsActionButton
                  color="primary"
                  variant="solid"
                  data-testid="settings-enable-mfa-btn"
                  onClick={handleEnableMFA}
                  loading={setupMFA.isPending}
                  sx={{ fontSize: '13px' }}
                >
                  Enable
                </SettingsActionButton>
              )}
              {mfaStatus?.enabled && authedSettingsLoaded && !mfaEnforced && (
                <SettingsActionButton
                  color="danger"
                  variant="outlined"
                  data-testid="settings-disable-mfa-btn"
                  onClick={() => setShowDisableConfirm(true)}
                  loading={disableMFA.isPending}
                  sx={{ fontSize: '13px' }}
                >
                  Disable
                </SettingsActionButton>
              )}
              {mfaStatus?.enabled && (
                <SettingsActionButton
                  color="primary"
                  variant="outlined"
                  data-testid="settings-regenerate-backup-codes-btn"
                  onClick={() => setShowRegenerateConfirm(true)}
                  loading={regenerateBackupCodes.isPending}
                  sx={{ fontSize: '13px' }}
                >
                  {(mfaStatus?.backupCodesCount || 0) > 0 ? 'Regenerate Backup Codes' : 'Generate Backup Codes'}
                </SettingsActionButton>
              )}
            </Box>
          </Box>
        </Grid>
      </Grid>

      <PasskeysSection enabled={!!mfaStatus?.enabled} />
      <TrustedDevicesSection enabled={!!mfaStatus?.enabled} />

      {showMFAModal && (
        <MFAModal
          key={`mfa-setup-${setupMFA.data?.secret || 'loading'}`}
          open={showMFAModal}
          onClose={() => setShowMFAModal(false)}
          onCancel={handleCancelSetup}
          mode="setup"
          title="Set Up Multi-Factor Authentication"
          description="Scan the QR code with your authenticator app, then enter the verification code."
          qrCodeUrl={setupMFA.data?.qrCodeUrl}
          manualEntryKey={setupMFA.data?.manualEntryKey}
          backupCodes={setupMFA.data?.backupCodes}
          onVerify={handleMFAVerification}
          loading={setupMFA.isPending || verifyMFASetup.isPending}
          showVerify={!setupMFA.isPending && !setupMFA.isError && !!setupMFA.data}
          isEnforced={false}
        />
      )}

      <Modal open={!!showBackupCodes} onClose={() => setShowBackupCodes(null)}>
        <ModalDialog>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Your Backup Codes
          </Typography>
          <Alert color="warning" sx={{ mb: 2 }}>
            Save these backup codes in a secure location. Each code can only be used once.
          </Alert>
          {showBackupCodes && (
            <Box
              sx={{
                fontFamily: 'monospace',
                fontSize: '14px',
                backgroundColor: 'background.level1',
                p: 2,
                borderRadius: 'md',
                mb: 2,
              }}
            >
              {showBackupCodes.map((code, index) => (
                <div key={index}>{code}</div>
              ))}
            </Box>
          )}
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              color="neutral"
              data-testid="settings-backup-codes-copy-btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(showBackupCodes?.join('\n') || '');
                  toast.success('Backup codes copied');
                } catch {
                  toast.error('Could not copy backup codes. Select and copy them manually.');
                }
              }}
              fullWidth
            >
              Copy
            </Button>
            <Button
              variant="outlined"
              color="neutral"
              data-testid="settings-backup-codes-download-btn"
              onClick={() => {
                const element = document.createElement('a');
                const file = new Blob([showBackupCodes?.join('\n') || ''], { type: 'text/plain' });
                element.href = URL.createObjectURL(file);
                element.download = 'mfa-backup-codes.txt';
                document.body.appendChild(element);
                element.click();
                document.body.removeChild(element);
                URL.revokeObjectURL(element.href);
              }}
              fullWidth
            >
              Download
            </Button>
            <Button onClick={() => setShowBackupCodes(null)} fullWidth>
              Done
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      <ConfirmActionModal
        open={showDisableConfirm}
        title="Disable Multi-Factor Authentication"
        description="Are you sure you want to disable Multi-Factor Authentication? This will make your account less secure, sign you out on all devices, and remove your passkeys and trusted devices. This action cannot be undone."
        onGoBackward={() => setShowDisableConfirm(false)}
        onGoForward={confirmDisableMFA}
        forwardButtonText="Disable MFA"
        backwardButtonText="Cancel"
        disabledConfirm={disableMFA.isPending}
      />

      <ConfirmActionModal
        open={showRegenerateConfirm}
        title="Generate New Backup Codes"
        description="This will create new backup codes and immediately invalidate all your existing codes. The new codes will be shown only once for security - make sure you're ready to save them safely. This action cannot be undone."
        onGoBackward={() => setShowRegenerateConfirm(false)}
        onGoForward={confirmRegenerateBackupCodes}
        forwardButtonText="Generate New Codes"
        backwardButtonText="Cancel"
        disabledConfirm={regenerateBackupCodes.isPending}
      />
    </>
  );
};

export default MfaCard;
