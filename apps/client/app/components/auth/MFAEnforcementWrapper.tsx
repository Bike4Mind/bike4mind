import React, { useEffect, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useMFAStatus, useSetupMFA, useVerifyMFASetup } from '@client/app/hooks/data/mfa';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import MFAModal from '@client/app/components/common/MFAModal';
import { Box, Typography, Alert, CircularProgress } from '@mui/joy';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

interface MFAEnforcementWrapperProps {
  children: React.ReactNode;
}

const MFAEnforcementWrapper: React.FC<MFAEnforcementWrapperProps> = ({ children }) => {
  const currentUser = useUser(s => s.currentUser);
  const { settings: adminSettings, isLoading: adminSettingsLoading } = useAdminSettings();
  const queryClient = useQueryClient();
  const [showMFASetup, setShowMFASetup] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Get MFA enforcement setting from admin settings
  const enforceMFA = adminSettings?.enforceMFA === 'true';

  // Check if user already has MFA configured (from user object)
  const userHasMFA = !!(currentUser?.mfa && currentUser.mfa.totpEnabled);

  // Only call MFA status API if enforcement is enabled
  const shouldCheckMFA = !!enforceMFA;

  // Get user's MFA status (only if needed)
  const mfaStatusQuery = useMFAStatus(shouldCheckMFA);
  const mfaStatus = mfaStatusQuery.data;
  const mfaQueryFailed = mfaStatusQuery.isError;

  const isImpersonating = useAccessToken(s => !!s.returnToken);

  // MFA mutations
  const setupMFA = useSetupMFA();
  const { mutate: setupMFAMutate, isPending: setupMFAIsPending, data: setupMFAData } = setupMFA;
  const verifyMFASetup = useVerifyMFASetup();

  useEffect(() => {
    if (showMFASetup) {
      // Modal opened; no side effects required.
    }
  }, [showMFASetup, setupMFA.data, enforceMFA, shouldCheckMFA]);

  // Check if user needs to be forced to setup MFA
  useEffect(() => {
    // Must be first: setupMFA.mutate() writes to DB and must not fire during impersonation
    if (isImpersonating) {
      setIsLoading(false);
      return;
    }

    if (!currentUser) {
      return;
    }

    // Wait for admin settings to load before making any MFA decisions
    if (adminSettingsLoading) {
      return;
    }

    // If we don't need to check MFA at all, skip all MFA logic
    if (!shouldCheckMFA) {
      setIsLoading(false);
      return;
    }

    // If we need to check MFA and the query is still loading, wait
    if (shouldCheckMFA && mfaStatusQuery.isLoading) {
      return;
    }

    setIsLoading(false);

    // If MFA query failed (and we were checking), skip enforcement (allow normal app access)
    if (shouldCheckMFA && mfaQueryFailed) {
      return;
    }

    // If MFA is enforced and user doesn't have it configured, force setup.
    // When enforced it applies to ALL users (no "internal" distinction).
    if (enforceMFA && (!mfaStatus?.enabled || !currentUser.mfa?.totpEnabled)) {
      // Auto-start MFA setup
      if (!showMFASetup && !setupMFAIsPending && !setupMFAData) {
        setupMFAMutate(undefined, {
          onSuccess: () => {
            setShowMFASetup(true);
            toast.info('Please complete MFA setup to continue');
          },
          onError: (error: any) => {
            // Extract the actual error message from axios response
            const errorMessage = error.response?.data?.error || error.message || 'Failed to setup MFA';
            toast.error(errorMessage);
          },
        });
      }
    }
  }, [
    isImpersonating,
    currentUser,
    enforceMFA,
    userHasMFA,
    shouldCheckMFA,
    mfaStatus,
    mfaStatusQuery.isLoading,
    mfaStatusQuery.data,
    mfaQueryFailed,
    showMFASetup,
    setupMFAMutate,
    setupMFAIsPending,
    setupMFAData,
    adminSettings,
    adminSettingsLoading,
  ]);

  const handleMFAVerification = (token: string) => {
    verifyMFASetup.mutate(
      { token },
      {
        onSuccess: data => {
          setShowMFASetup(false);
          toast.success('MFA setup completed successfully');

          // Refresh all relevant data
          mfaStatusQuery.refetch();
          queryClient.invalidateQueries({ queryKey: ['user'] });
          queryClient.invalidateQueries({ queryKey: ['auth', 'identify'] });

          // Force re-evaluation by triggering useEffect
          setIsLoading(true);

          if (data?.user) {
            // Updated user returned; the query invalidations above handle the refresh.
          }
        },
        onError: (error: any) => {
          const errorData = error.response?.data;

          // 3-Strike Security: Handle forced logout
          if (errorData?.forceLogout) {
            // Clear tokens and mfaPending flag (forced logout: expired: true)
            useAccessToken.getState().forceLogoutTokens();

            // Hide setup modal and show error
            setShowMFASetup(false);
            toast.error(errorData.error || 'Too many failed attempts. Please log in again.');
            // Redirect this (active) tab to /login too: forceLogoutTokens() cleared the
            // session, so without this the tab is stranded on the MFA screen. Use the
            // session_revoked error code (not a plain /login) so the reason reliably shows
            // on the login page via getLoginErrorMessage - the toast above can be lost when
            // window.location.replace tears down the DOM before sonner paints. Mirrors the
            // cross-tab background-tab UX.
            window.location.replace(buildLoginRedirectUrl('session_revoked', window.location));
            return;
          }

          // Update tokens if new attempt count provided (for next try)
          if (errorData?.accessToken && errorData?.refreshToken) {
            // Still mid-MFA (next attempt): keep mfaPending true via the named action so the
            // invariant can't be dropped.
            useAccessToken.getState().setMfaPendingTokens(errorData.accessToken, errorData.refreshToken);
          }

          // Show error with attempts remaining
          const baseError = errorData?.error || error.message || 'MFA verification failed';
          const attemptsInfo = errorData?.attemptsRemaining
            ? ` (${errorData.attemptsRemaining} attempts remaining)`
            : '';

          toast.error(baseError + attemptsInfo);
        },
      }
    );
  };

  // Skip enforcement entirely during admin impersonation sessions
  // Must come after ALL hook calls (Rules of Hooks)
  if (isImpersonating) {
    return <>{children}</>;
  }

  // Show loading while checking MFA status (only if we need to check MFA)
  const showLoading = isLoading || (shouldCheckMFA && mfaStatusQuery.isLoading) || adminSettingsLoading;

  if (showLoading) {
    return (
      <Box
        data-testid="mfa-enforcement-loading"
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <CircularProgress aria-label="Checking security settings" data-testid="mfa-enforcement-loading-spinner" />
        <Typography level="body-md" sx={{ color: 'text.tertiary' }} data-testid="mfa-enforcement-loading-message">
          Checking security settings...
        </Typography>
      </Box>
    );
  }

  // If MFA is enforced and user hasn't configured it, block access
  // But only if the MFA query succeeded (don't block if query failed)
  if (enforceMFA && !mfaQueryFailed && (!mfaStatus?.enabled || !currentUser?.mfa?.totpEnabled)) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: 3,
          px: 3,
        }}
      >
        <Typography level="h2" textAlign="center">
          Multi-Factor Authentication Required
        </Typography>

        <Alert color="warning" sx={{ maxWidth: 500 }}>
          Your administrator has enabled Multi-Factor Authentication for all users. You must set up MFA before you can
          access the application.
        </Alert>

        <Typography level="body-md" textAlign="center" sx={{ color: 'text.secondary' }}>
          We&apos;re setting up MFA for your account. Please wait...
        </Typography>

        {/* MFA Setup Modal */}
        {showMFASetup && setupMFAData && (
          <MFAModal
            open={showMFASetup}
            onClose={() => {}} // Don't allow closing when enforced
            onCancel={() => {}} // Don't allow cancel when enforced
            title="Set Up Multi-Factor Authentication (Enforced)"
            description="Scan the QR code with your authenticator app, then enter the verification code."
            qrCodeUrl={setupMFAData.qrCodeUrl}
            manualEntryKey={setupMFAData.manualEntryKey}
            backupCodes={setupMFAData.backupCodes}
            onVerify={handleMFAVerification}
            loading={verifyMFASetup.isPending}
            showVerify={true}
            isEnforced={true} // This will hide the close button
          />
        )}
      </Box>
    );
  }

  // If we get here, either MFA is not enforced or user has it configured
  return <>{children}</>;
};

export default MFAEnforcementWrapper;
