import React, { useState } from 'react';
import { Button, Card, Stack, Typography, Alert, Box, Modal, ModalDialog, ModalClose, styled } from '@mui/joy';
import SecurityIcon from '@mui/icons-material/Security';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useQueryClient } from '@tanstack/react-query';
import {
  useSetupMFA,
  useVerifyMFASetup,
  useDisableMFA,
  useRegenerateBackupCodes,
  useMFAStatus,
  useCancelMFASetup,
} from '@client/app/hooks/data/mfa';
import MFAModal from '@client/app/components/common/MFAModal';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { toast } from 'sonner';

// Styled button to match profile styling
const StyledButton = styled(Button)(({ theme }) => ({
  gap: '.5rem',
}));

const MFASection: React.FC = () => {
  const { currentUser, refreshUser } = useUser();
  const { settings: adminSettings, isLoading: adminSettingsLoading } = useAdminSettings();
  const queryClient = useQueryClient();

  const [showMFAModal, setShowMFAModal] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState<string[] | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  const enforceMFA = adminSettings?.enforceMFA === 'true';

  const userHasMFA = !!(currentUser?.mfa && currentUser.mfa.totpEnabled);

  // Only check MFA status if enforcement is enabled OR user already has MFA
  const shouldCheckMFA = !!enforceMFA || userHasMFA;

  const mfaStatusQuery = useMFAStatus(shouldCheckMFA);
  const mfaStatus = shouldCheckMFA ? mfaStatusQuery.data : null;

  // MFA mutations
  const setupMFA = useSetupMFA();
  const verifyMFASetup = useVerifyMFASetup();
  const disableMFA = useDisableMFA();
  const regenerateBackupCodes = useRegenerateBackupCodes();
  const cancelMFASetup = useCancelMFASetup();

  const handleEnableMFA = () => {
    setupMFA.mutate(undefined, {
      onSuccess: data => {
        setShowMFAModal(true);
        toast.success('MFA setup initiated');
      },
      onError: (error: any) => {
        // Extract the actual error message from axios response
        const errorMessage = error.response?.data?.error || error.message || 'Failed to setup MFA';
        toast.error(errorMessage);
      },
    });
  };

  const handleDisableMFA = () => {
    setShowDisableConfirm(true);
  };

  const confirmDisableMFA = () => {
    setShowDisableConfirm(false);
    disableMFA.mutate(undefined, {
      onSuccess: () => {
        toast.success('MFA disabled successfully');
        // Refresh MFA status and user data so the section and the admin Users
        // badge reflect the disabled state without a page refresh. See the enable
        // handler for why refreshUser() (Zustand) + ['identify']/['users'] are used.
        mfaStatusQuery.refetch();
        refreshUser();
        queryClient.invalidateQueries({ queryKey: ['identify'] });
        queryClient.invalidateQueries({ queryKey: ['users'] });
      },
      onError: (error: any) => {
        // Extract the actual error message from axios response
        const errorMessage = error.response?.data?.error || error.message || 'Failed to disable MFA';
        toast.error(errorMessage);
      },
    });
  };

  const handleRegenerateBackupCodes = () => {
    setShowRegenerateConfirm(true);
  };

  const confirmRegenerateBackupCodes = () => {
    setShowRegenerateConfirm(false);
    regenerateBackupCodes.mutate(undefined, {
      onSuccess: (data: any) => {
        if (data.backupCodes) {
          setShowBackupCodes(data.backupCodes);
        }
        toast.success('New backup codes generated successfully. Save them now!');

        // Refresh MFA status to update the backup-code count, and sync the user
        // store/auth cache. Regenerating codes doesn't change totpEnabled, so the
        // admin Users badge (['users']) doesn't need invalidating here.
        mfaStatusQuery.refetch();
        refreshUser();
        queryClient.invalidateQueries({ queryKey: ['identify'] });
      },
      onError: (error: any) => {
        // Extract the actual error message from axios response
        const errorMessage = error.response?.data?.error || error.message || 'Failed to regenerate backup codes';
        toast.error(errorMessage);
      },
    });
  };

  const handleMFAVerification = (token: string) => {
    verifyMFASetup.mutate(
      { token },
      {
        onSuccess: (data: any) => {
          setShowMFAModal(false);
          if (data.backupCodes) {
            setShowBackupCodes(data.backupCodes);
          }
          toast.success('MFA enabled successfully');

          // Refresh MFA status and user data. `currentUser` lives in the Zustand
          // useUser store (not React Query), and `userHasMFA`/`shouldCheckMFA` are
          // derived from `currentUser.mfa.totpEnabled`. refreshUser() re-runs
          // /api/identify and writes the fresh user into the store so the section
          // flips to "Enabled" without a page refresh. Invalidate the real query
          // keys too: ['identify'] for the auth cache and ['users'] so the admin
          // Users view's MFA badge updates.
          mfaStatusQuery.refetch();
          refreshUser();
          queryClient.invalidateQueries({ queryKey: ['identify'] });
          queryClient.invalidateQueries({ queryKey: ['users'] });
        },
        onError: (error: any) => {
          const errorData = error.response?.data;

          // 3-Strike Security: Handle forced logout (though less likely in profile setting)
          if (errorData?.forceLogout) {
            console.log('🔍 MFA Profile: Too many attempts, closing modal');
            setShowMFAModal(false);
            toast.error('Too many failed attempts. Please try setting up MFA again later.');
            return;
          }

          // Extract the actual error message from axios response
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

  // Don't show anything while loading admin settings (we need them to determine enforcement)
  // or if MFA status is still loading
  if (adminSettingsLoading || (shouldCheckMFA && mfaStatusQuery.isLoading)) {
    return null;
  }

  // If MFA enforcement is disabled and user doesn't have MFA, show simplified section
  if (!shouldCheckMFA) {
    return (
      <>
        <Card variant="outlined" sx={{ p: 3 }}>
          <Typography level="h4" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
            <SecurityIcon /> Multi-Factor Authentication
          </Typography>

          <Stack spacing={2}>
            <Box>
              <Typography level="body-sm" sx={{ mb: 1 }}>
                Status: <span style={{ color: 'orange', fontWeight: 'bold' }}>Disabled</span>
              </Typography>
            </Box>

            <StyledButton
              color="primary"
              variant="solid"
              startDecorator={<VpnKeyIcon />}
              onClick={handleEnableMFA}
              loading={setupMFA.isPending}
              fullWidth
            >
              Enable Multi-Factor Authentication
            </StyledButton>
          </Stack>
        </Card>

        {/* MFA Setup Modal for simplified version */}
        {showMFAModal && (
          <MFAModal
            key={`mfa-setup-${setupMFA.data?.secret || 'loading'}`}
            open={showMFAModal}
            onClose={() => setShowMFAModal(false)}
            onCancel={handleCancelSetup}
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

        {/* Backup Codes Modal for simplified version */}
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
            <StyledButton onClick={() => setShowBackupCodes(null)}>I&apos;ve Saved These Codes</StyledButton>
          </ModalDialog>
        </Modal>

        {/* Disable MFA Confirmation Modal for simplified version */}
        <ConfirmActionModal
          open={showDisableConfirm}
          title="Disable Multi-Factor Authentication"
          description="Are you sure you want to disable Multi-Factor Authentication? This will make your account less secure. This action cannot be undone."
          onGoBackward={() => setShowDisableConfirm(false)}
          onGoForward={() => confirmDisableMFA()}
          forwardButtonText="Disable MFA"
          backwardButtonText="Cancel"
          disabledConfirm={disableMFA.isPending}
        />
      </>
    );
  }

  const isEnabled = mfaStatus?.enabled || false;
  const hasBackupCodes = (mfaStatus?.backupCodesCount || 0) > 0;

  return (
    <>
      <Card variant="outlined" sx={{ p: 3 }}>
        <Typography level="h4" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <SecurityIcon /> Multi-Factor Authentication
        </Typography>

        <Stack spacing={2}>
          {/* MFA Status */}
          <Box>
            <Typography level="body-sm" sx={{ mb: 1 }}>
              Status:{' '}
              {isEnabled ? (
                <span style={{ color: 'green', fontWeight: 'bold' }}>Enabled</span>
              ) : (
                <span style={{ color: 'orange', fontWeight: 'bold' }}>Disabled</span>
              )}
              {enforceMFA && isEnabled && (
                <span style={{ color: 'orange', fontWeight: 'normal', marginLeft: '8px' }}>
                  (Required by administrator)
                </span>
              )}
            </Typography>

            {enforceMFA && !isEnabled && (
              <Alert color="warning" size="sm" sx={{ mb: 2 }}>
                Multi-Factor Authentication is required by your administrator. Please set it up.
              </Alert>
            )}
          </Box>

          {/* Enable MFA button - only when not enabled */}
          {!isEnabled && (
            <StyledButton
              color="primary"
              variant="solid"
              startDecorator={<VpnKeyIcon />}
              onClick={handleEnableMFA}
              loading={setupMFA.isPending}
              fullWidth
            >
              Enable Multi-Factor Authentication
            </StyledButton>
          )}

          {/* MFA Actions - show relevant buttons together */}
          {isEnabled && (
            <Stack spacing={1}>
              {/* Disable MFA - only show if not enforced */}
              {!enforceMFA && (
                <StyledButton
                  color="danger"
                  startDecorator={<VpnKeyIcon />}
                  onClick={handleDisableMFA}
                  loading={disableMFA.isPending}
                  fullWidth
                >
                  Disable Multi-Factor Authentication
                </StyledButton>
              )}

              {/* Regenerate Backup Codes */}
              <StyledButton
                color="neutral"
                variant="outlined"
                startDecorator={<RefreshIcon />}
                onClick={handleRegenerateBackupCodes}
                loading={regenerateBackupCodes.isPending}
                fullWidth
              >
                {hasBackupCodes ? 'Regenerate Backup Codes' : 'Generate Backup Codes'}
              </StyledButton>
            </Stack>
          )}
        </Stack>
      </Card>

      {/* MFA Setup Modal */}
      {showMFAModal && (
        <MFAModal
          key={`mfa-setup-${setupMFA.data?.secret || 'loading'}`}
          open={showMFAModal}
          onClose={() => setShowMFAModal(false)}
          onCancel={handleCancelSetup}
          title={
            setupMFA.isPending
              ? 'Setting up Multi-Factor Authentication...'
              : setupMFA.isError
                ? 'MFA Setup Error'
                : 'Set Up Multi-Factor Authentication (Profile)'
          }
          description={
            setupMFA.isPending
              ? 'Please wait while we prepare your MFA setup.'
              : setupMFA.isError
                ? `Setup failed: ${setupMFA.error?.message || 'Unknown error'}`
                : 'Scan the QR code with your authenticator app, then enter the verification code.'
          }
          qrCodeUrl={setupMFA.data?.qrCodeUrl}
          manualEntryKey={setupMFA.data?.manualEntryKey}
          backupCodes={setupMFA.data?.backupCodes}
          onVerify={handleMFAVerification}
          loading={setupMFA.isPending || verifyMFASetup.isPending}
          showVerify={!setupMFA.isPending && !setupMFA.isError && !!setupMFA.data}
          isEnforced={false}
        />
      )}

      {/* Backup Codes Modal */}
      <Modal open={!!showBackupCodes} onClose={() => setShowBackupCodes(null)}>
        <ModalDialog sx={{ maxWidth: '400px' }}>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Backup Codes
          </Typography>

          {showBackupCodes && (
            <Box
              sx={{
                fontFamily: 'monospace',
                fontSize: '14px',
                backgroundColor: 'background.level1',
                p: 2,
                borderRadius: 'md',
                mb: 2,
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              {showBackupCodes.map((code, index) => (
                <Box key={index} sx={{ p: 0.5 }}>
                  {code}
                </Box>
              ))}
            </Box>
          )}

          <Stack direction="row" spacing={1}>
            <StyledButton
              color="neutral"
              variant="outlined"
              onClick={() => {
                navigator.clipboard.writeText(showBackupCodes?.join('\n') || '');
              }}
              fullWidth
            >
              Copy
            </StyledButton>
            <StyledButton
              color="neutral"
              variant="outlined"
              onClick={() => {
                const element = document.createElement('a');
                const file = new Blob([showBackupCodes?.join('\n') || ''], { type: 'text/plain' });
                element.href = URL.createObjectURL(file);
                element.download = 'mfa-backup-codes.txt';
                document.body.appendChild(element);
                element.click();
                document.body.removeChild(element);
              }}
              fullWidth
            >
              Download
            </StyledButton>
            <StyledButton color="primary" onClick={() => setShowBackupCodes(null)} fullWidth>
              Done
            </StyledButton>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Disable MFA Confirmation Modal */}
      <ConfirmActionModal
        open={showDisableConfirm}
        title="Disable Multi-Factor Authentication"
        description="Are you sure you want to disable Multi-Factor Authentication? This will make your account less secure. This action cannot be undone."
        onGoBackward={() => setShowDisableConfirm(false)}
        onGoForward={() => confirmDisableMFA()}
        forwardButtonText="Disable MFA"
        backwardButtonText="Cancel"
        disabledConfirm={disableMFA.isPending}
      />

      {/* Regenerate Backup Codes Confirmation Modal */}
      <ConfirmActionModal
        open={showRegenerateConfirm}
        title="Generate New Backup Codes"
        description="This will create new backup codes and immediately invalidate all your existing codes. The new codes will be shown only once for security - make sure you're ready to save them safely. This action cannot be undone."
        onGoBackward={() => setShowRegenerateConfirm(false)}
        onGoForward={() => confirmRegenerateBackupCodes()}
        forwardButtonText="Generate New Codes"
        backwardButtonText="Cancel"
        disabledConfirm={regenerateBackupCodes.isPending}
      />
    </>
  );
};

export default MFASection;
