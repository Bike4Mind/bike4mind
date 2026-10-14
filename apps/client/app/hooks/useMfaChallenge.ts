import { useRef, useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import type { IUserDocument } from '@bike4mind/common';
import type MFAModal from '@client/app/components/common/MFAModal';
import { useSetupMFA, useVerifyMFA, useVerifyMFASetup, type MFASetupResponse } from '@client/app/hooks/data/mfa';
import { describePasskeyMfaError, passkeysSupported, useVerifyPasskeyMFA } from '@client/app/hooks/data/passkeys';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { resetRefreshCoordinator } from '@client/app/utils/refreshCoordinator';
import { resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';

export type MfaChallengeMode = 'verify' | 'setup';

/** A sign-in that proved its first factor and now owes the second (server: signInSecondFactor.ts). */
export type MfaChallengeStart = {
  userId: string;
  /** mfaPending access token: accepted only by the MFA routes. */
  mfaToken: string;
  mode: MfaChallengeMode;
  passkeyAvailable?: boolean;
};

export type MfaLoginResult = { accessToken: string; user: IUserDocument };

type MfaChallengeOptions = {
  /** Runs once the full session is stored; set the current user and navigate from here. */
  onComplete: (result: MfaLoginResult) => void;
  /** Runs after the challenge ends without a session (abandoned, or enrollment could not
   *  start) and the pending token is dropped. */
  onCancel?: (mode: MfaChallengeMode) => void;
  /** Offer "remember this device" (verification only; MFAModal hides it during setup). */
  allowRememberDevice?: boolean;
};

type MfaModalProps = ComponentProps<typeof MFAModal>;

type ChallengeState = { userId: string; mode: MfaChallengeMode; passkeyAvailable: boolean };

const MFA_SETUP_DESCRIPTION =
  'Your administrator requires MFA. Scan the QR code with your authenticator app to set up MFA.';

function toMfaLoginResult(data: unknown): MfaLoginResult {
  const result = data as Partial<MfaLoginResult> | null;
  if (!result || typeof result.accessToken !== 'string' || !result.user) {
    throw new Error('MFA verification returned no session');
  }
  return { accessToken: result.accessToken, user: result.user };
}

function readErrorData(error: unknown): Record<string, unknown> | undefined {
  return (error as { response?: { data?: Record<string, unknown> } })?.response?.data;
}

/**
 * The second-factor step of every browser sign-in: holds the mfaPending token, drives the
 * MFAModal (TOTP/backup code, passkey, or enforced enrollment) and stores the full session
 * the MFA routes mint. Render `<MFAModal {...modalProps} />` and call `begin` when a sign-in
 * response asks for MFA.
 */
export function useMfaChallenge({ onComplete, onCancel, allowRememberDevice = false }: MfaChallengeOptions) {
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupData, setSetupData] = useState<MFASetupResponse | null>(null);

  const setupMFA = useSetupMFA();
  const verifyMFA = useVerifyMFA();
  const verifyMFASetup = useVerifyMFASetup();
  const verifyPasskeyMFA = useVerifyPasskeyMFA();

  const reset = () => {
    setOpen(false);
    setChallenge(null);
    setError(null);
    setSetupData(null);
  };

  // A handoff can arrive while this browser already holds a verified session. begin() overwrites
  // the in-memory token with the pending one, so keep the old one to restore on cancel:
  // resetTokens() would persist hasSession:false and sign out every tab.
  const previousVerifiedToken = useRef<string | null>(null);
  // Whether this browser believed it held a session when the challenge began. A handoff that lands
  // on a fresh document load (the /auth/success redirect) has no in-memory token to restore, so the
  // flag is what distinguishes "cancel this sign-in" from "sign me out everywhere". It can be stale
  // (a refresh cookie that expired while the browser was closed): the destination route's bootstrap
  // is what decides whether a session is really there, not this flag.
  const hadSession = useRef(false);

  const endWithoutSession = (mode: MfaChallengeMode) => {
    const { setVerifiedSession, resetTokens } = useAccessToken.getState();
    if (previousVerifiedToken.current) {
      setVerifiedSession(previousVerifiedToken.current);
    } else if (hadSession.current) {
      // Only the pending token is dropped. resetTokens() would persist hasSession:false, which
      // the cross-tab listener (crossTabLogout.ts) reads as "the other tab logged out".
      useAccessToken.setState({ accessToken: null, mfaPending: false });
    } else {
      resetTokens();
    }
    previousVerifiedToken.current = null;
    hadSession.current = false;
    reset();
    onCancel?.(mode);
  };

  const finish = (data: unknown) => {
    const result = toMfaLoginResult(data);
    resetRefreshCoordinator();
    // Drop the cached cold-load result: this browser just acquired a session, so the next
    // protected navigation must not reuse the "no session" answer from before login.
    resetSessionBootstrap();
    useAccessToken.getState().setVerifiedSession(result.accessToken);
    previousVerifiedToken.current = null;
    reset();
    onComplete(result);
  };

  const begin = async ({ userId, mfaToken, mode, passkeyAvailable = false }: MfaChallengeStart) => {
    const { accessToken, mfaPending, hasSession, setMfaPendingTokens } = useAccessToken.getState();
    previousVerifiedToken.current = accessToken && !mfaPending ? accessToken : null;
    hadSession.current = hasSession;
    setMfaPendingTokens(mfaToken);
    setChallenge({ userId, mode, passkeyAvailable: mode === 'verify' && passkeyAvailable });
    setError(null);
    if (mode === 'verify') {
      setOpen(true);
      return;
    }
    try {
      setSetupData(await setupMFA.mutateAsync());
      setOpen(true);
    } catch (setupError: unknown) {
      toast.error((readErrorData(setupError)?.error as string) || (setupError as Error).message || 'MFA setup failed');
      // Ends the sign-in like a cancel: the caller must leave its waiting state, and a consumed
      // first-factor nonce (OTC) cannot be resumed anyway. `challenge` state has not updated
      // within this call, so the mode is passed explicitly.
      endWithoutSession('setup');
    }
  };

  const handleVerify = async (code: string, rememberDevice: boolean) => {
    if (!challenge) return;
    setError(null);
    try {
      finish(
        challenge.mode === 'setup'
          ? await verifyMFASetup.mutateAsync({ token: code })
          : await verifyMFA.mutateAsync({ token: code, rememberDevice: allowRememberDevice && rememberDevice })
      );
    } catch (verifyError: unknown) {
      const errorData = readErrorData(verifyError);
      const baseError = (errorData?.error as string) || (verifyError as Error).message || 'MFA verification failed';
      const attemptsInfo = errorData?.attemptsRemaining ? ` (${errorData.attemptsRemaining} attempts remaining)` : '';
      setError(baseError + attemptsInfo);
    }
  };

  const handlePasskeyVerify = async (rememberDevice: boolean) => {
    if (!challenge) return;
    setError(null);
    try {
      finish(await verifyPasskeyMFA.mutateAsync({ rememberDevice: allowRememberDevice && rememberDevice }));
    } catch (passkeyError: unknown) {
      setError(describePasskeyMfaError(passkeyError));
    }
  };

  const handleCancel = () => endWithoutSession(challenge?.mode ?? 'verify');

  const mode = challenge?.mode ?? 'verify';
  const passkeyAvailable = !!challenge?.passkeyAvailable;
  const modalProps: MfaModalProps = {
    className: 'mfa-modal',
    open,
    onClose: handleCancel,
    onCancel: handleCancel,
    onVerify: handleVerify,
    loading: verifyMFA.isPending || verifyMFASetup.isPending,
    error,
    title: mode === 'setup' ? 'Set Up Multi-Factor Authentication' : 'Multi-Factor Authentication Required',
    description:
      mode === 'setup'
        ? MFA_SETUP_DESCRIPTION
        : passkeyAvailable && passkeysSupported()
          ? 'Use your passkey, or enter your 6-digit code or backup code to continue.'
          : 'Enter your 6-digit code or backup code to continue.',
    qrCodeUrl: setupData?.qrCodeUrl,
    manualEntryKey: setupData?.manualEntryKey,
    backupCodes: setupData?.backupCodes,
    showVerify: true,
    allowRememberDevice,
    onPasskeyVerify: passkeyAvailable ? handlePasskeyVerify : undefined,
    passkeyLoading: verifyPasskeyMFA.isPending,
  };

  return { begin, modalProps };
}
