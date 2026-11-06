import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useMFAStatus, useSetupMFA, useVerifyMFASetup } from '@client/app/hooks/data/mfa';
import { useUserLogout } from '@client/app/hooks/data/user';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { registerMfaEnrollmentInterceptor } from '@client/app/utils/mfaEnrollmentInterceptor';
import { api } from '@client/app/contexts/ApiContext';
import { ADMIN_SETTINGS_QUERY_KEY } from '@client/app/hooks/data/queryKeys';
import MFAModal from '@client/app/components/common/MFAModal';
import { Box, Typography, Alert, CircularProgress, Button } from '@mui/joy';
import { toast } from 'sonner';
import { isAxiosError } from 'axios';
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
  // The server answers an unenrolled session with a 403 instead of this tab's settings query
  // seeing the toggle. That refusal is authoritative even if the status query then errors.
  const [enrollmentRefused, setEnrollmentRefused] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Get MFA enforcement setting from admin settings
  const enforceMFA = adminSettings?.enforceMFA === 'true';

  // Only call MFA status API if enforcement is enabled
  const shouldCheckMFA = !!enforceMFA;

  // Get user's MFA status (only if needed)
  const mfaStatusQuery = useMFAStatus(shouldCheckMFA);
  const mfaStatus = mfaStatusQuery.data;
  const mfaQueryFailed = mfaStatusQuery.isError;
  // The status query is the authority, not currentUser.mfa: the persisted user store drops `mfa`,
  // so a reload rehydrates without it until /api/identify lands, and reading it here fired a
  // step-up-gated setup call at an enrolled user, which then 409'd.
  const needsEnrollment = !mfaStatus?.enabled;

  const isImpersonating = useAccessToken(s => s.impersonating);

  // MFA mutations
  const setupMFA = useSetupMFA();
  const {
    mutate: setupMFAMutate,
    isPending: setupMFAIsPending,
    data: setupMFAData,
    isError: setupMFAIsError,
    error: setupMFAError,
  } = setupMFA;
  // Dismissing the verification prompt is a choice, not a failure: offer to continue instead.
  const setupVerificationCancelled = setupMFAIsError && isStepUpCancelled(setupMFAError);
  const verifyMFASetup = useVerifyMFASetup();
  const { mutate: logout, isPending: logoutIsPending } = useUserLogout();

  // Shared by the auto-start effect and the manual retry button (see the enforced-block
  // screen). Calling mutate() clears the mutation's error state, so a retry re-opens the path
  // the `!setupMFAIsError` guard closes after a failure.
  const startMfaSetup = useCallback(() => {
    setupMFAMutate(undefined, {
      onSuccess: () => {
        setShowMFASetup(true);
        toast.info('Please complete MFA setup to continue');
      },
      onError: (error: unknown) => {
        if (isStepUpCancelled(error)) return;
        const response = isAxiosError(error) ? error.response : undefined;
        // Already enrolled: this tab's status was stale, so refresh it rather than report an error.
        if (response?.status === 409) {
          void mfaStatusQuery.refetch();
          return;
        }
        const serverMessage = (response?.data as { error?: string } | undefined)?.error;
        toast.error(serverMessage || (error instanceof Error && error.message) || 'Failed to setup MFA');
      },
    });
  }, [setupMFAMutate, mfaStatusQuery.refetch]);

  // The server refuses a session that owes enrollment as soon as its own settings cache sees
  // enforceMFA, which can be minutes before this tab's settings query refetches. Refetch on a
  // refusal so the enrollment flow renders instead of an app whose every call fails. One refetch
  // at a time: a burst of refusals would otherwise re-run the settings load once per 403. Re-arm
  // when it settles, since a failed or stale refetch must not leave later refusals ignored.
  const refusalRefetchInFlightRef = useRef(false);
  useEffect(
    () =>
      registerMfaEnrollmentInterceptor(api, () => {
        if (refusalRefetchInFlightRef.current) return;
        refusalRefetchInFlightRef.current = true;
        setEnrollmentRefused(true);
        void Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] }),
        ]).then(() => {
          refusalRefetchInFlightRef.current = false;
        });
      }),
    [queryClient]
  );

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

    // If MFA query failed (and we were checking), skip enforcement (allow normal app access) -
    // unless the server itself already refused a call for enrollment, which settles the question.
    if (shouldCheckMFA && mfaQueryFailed && !enrollmentRefused) {
      return;
    }

    // If MFA is enforced and user doesn't have it configured, force setup.
    // When enforced it applies to ALL users (no "internal" distinction).
    if (enforceMFA && needsEnrollment) {
      // Auto-start MFA setup. The `!setupMFAIsError` guard is load-bearing: on a persistent
      // /api/mfa/setup failure onError only toasts, so setupMFAData stays undefined and
      // setupMFAIsPending cycles true->false - both are effect deps, so without this guard the
      // settle re-runs the effect and re-fires the mutation at network speed, forever. Firing
      // once and stopping (the user gets a toast; a reload remounts and retries) is correct.
      if (!showMFASetup && !setupMFAIsPending && !setupMFAData && !setupMFAIsError) {
        startMfaSetup();
      }
    }
  }, [
    isImpersonating,
    currentUser,
    enforceMFA,
    needsEnrollment,
    shouldCheckMFA,
    mfaStatus,
    mfaStatusQuery.isLoading,
    mfaStatusQuery.data,
    mfaQueryFailed,
    showMFASetup,
    startMfaSetup,
    setupMFAIsPending,
    setupMFAData,
    setupMFAIsError,
    adminSettings,
    adminSettingsLoading,
    enrollmentRefused,
  ]);

  const handleMFAVerification = (token: string) => {
    setVerifyError(null);
    verifyMFASetup.mutate(
      { token },
      {
        onSuccess: () => {
          setShowMFASetup(false);
          toast.success('MFA setup completed successfully');

          // Refresh all relevant data
          mfaStatusQuery.refetch();
          queryClient.invalidateQueries({ queryKey: ['user'] });
          queryClient.invalidateQueries({ queryKey: ['auth', 'identify'] });

          // Force re-evaluation by triggering useEffect
          setIsLoading(true);
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

          // Show error with attempts remaining
          const baseError = errorData?.error || error.message || 'MFA verification failed';
          const attemptsInfo = errorData?.attemptsRemaining
            ? ` (${errorData.attemptsRemaining} attempts remaining)`
            : '';

          setVerifyError(baseError + attemptsInfo);
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

  // If MFA is enforced and user hasn't configured it, block access.
  // A failed status query normally leaves the app alone, but an observed enrollment refusal is
  // the server telling us this session owes enrollment, so it blocks regardless.
  if (enforceMFA && (!mfaQueryFailed || enrollmentRefused) && needsEnrollment) {
    return (
      <Box
        data-testid="mfa-enforcement-required-screen"
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

        {setupVerificationCancelled ? (
          <>
            <Typography level="body-md" textAlign="center" sx={{ color: 'text.secondary' }}>
              Confirm it&apos;s you to start MFA setup.
            </Typography>
            <Button data-testid="mfa-enforcement-continue-btn" onClick={startMfaSetup} loading={setupMFAIsPending}>
              Continue MFA setup
            </Button>
          </>
        ) : setupMFAIsError ? (
          // A failed setup used to dead-end here on "please wait" forever (the auto-retry
          // guard intentionally won't re-fire, and the only signal was a toast that has
          // faded). Give the user an explicit way back in.
          <>
            <Typography level="body-md" textAlign="center" sx={{ color: 'text.secondary' }}>
              We couldn&apos;t start MFA setup. Please try again.
            </Typography>
            <Button data-testid="mfa-enforcement-retry-btn" onClick={startMfaSetup} loading={setupMFAIsPending}>
              Retry MFA setup
            </Button>
          </>
        ) : (
          <Typography level="body-md" textAlign="center" sx={{ color: 'text.secondary' }}>
            We&apos;re setting up MFA for your account. Please wait...
          </Typography>
        )}

        {/* An older session must pass an emailed "Confirm it's you" check before setup; a fresh
            sign-in skips it (see setup.ts), so this is the way out for a user stuck at that check. */}
        <Button
          data-testid="mfa-enforcement-sign-out-btn"
          variant="plain"
          color="neutral"
          onClick={() => logout(undefined, { onError: () => toast.error("Couldn't sign out. Please try again.") })}
          loading={logoutIsPending}
        >
          Sign out and sign in again
        </Button>

        {/* MFA Setup Modal */}
        {showMFASetup && setupMFAData && (
          <MFAModal
            open={showMFASetup}
            onClose={() => {}} // Don't allow closing when enforced
            onCancel={() => {}} // Don't allow cancel when enforced
            mode="setup"
            title="Set Up Multi-Factor Authentication (Enforced)"
            description="Scan the QR code with your authenticator app, then enter the verification code."
            qrCodeUrl={setupMFAData.qrCodeUrl}
            manualEntryKey={setupMFAData.manualEntryKey}
            backupCodes={setupMFAData.backupCodes}
            onVerify={handleMFAVerification}
            loading={verifyMFASetup.isPending}
            error={verifyError}
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
