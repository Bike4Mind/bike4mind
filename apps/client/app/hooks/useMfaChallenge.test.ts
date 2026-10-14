// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setupMutateAsync: vi.fn(),
  verifyMutateAsync: vi.fn(),
  verifySetupMutateAsync: vi.fn(),
  verifyPasskeyMutateAsync: vi.fn(),
  setMfaPendingTokens: vi.fn(),
  setVerifiedSession: vi.fn(),
  resetTokens: vi.fn(),
  resetRefreshCoordinator: vi.fn(),
  resetSessionBootstrap: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useSetupMFA: () => ({ mutateAsync: mocks.setupMutateAsync, isPending: false }),
  useVerifyMFA: () => ({ mutateAsync: mocks.verifyMutateAsync, isPending: false }),
  useVerifyMFASetup: () => ({ mutateAsync: mocks.verifySetupMutateAsync, isPending: false }),
}));
vi.mock('@client/app/hooks/data/passkeys', () => ({
  describePasskeyMfaError: (error: unknown) => `passkey: ${(error as Error).message}`,
  passkeysSupported: () => true,
  useVerifyPasskeyMFA: () => ({ mutateAsync: mocks.verifyPasskeyMutateAsync, isPending: false }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: {
    getState: () => ({
      setMfaPendingTokens: mocks.setMfaPendingTokens,
      setVerifiedSession: mocks.setVerifiedSession,
      resetTokens: mocks.resetTokens,
    }),
  },
}));
vi.mock('@client/app/utils/refreshCoordinator', () => ({ resetRefreshCoordinator: mocks.resetRefreshCoordinator }));
vi.mock('@client/app/utils/sessionBootstrap', () => ({ resetSessionBootstrap: mocks.resetSessionBootstrap }));

import { useMfaChallenge } from './useMfaChallenge';

const session = { accessToken: 'full-access', user: { id: 'u1' } };
const verifyStart = { userId: 'u1', mfaToken: 'pending-tok', mode: 'verify' as const };

function setup(options: { allowRememberDevice?: boolean } = {}) {
  const onComplete = vi.fn();
  const onCancel = vi.fn();
  const rendered = renderHook(() => useMfaChallenge({ onComplete, onCancel, ...options }));
  return { ...rendered, onComplete, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyMutateAsync.mockResolvedValue(session);
  mocks.verifySetupMutateAsync.mockResolvedValue(session);
  mocks.setupMutateAsync.mockResolvedValue({ qrCodeUrl: 'qr', manualEntryKey: 'KEY', backupCodes: ['b1'] });
});

describe('useMfaChallenge begin', () => {
  it('stores the pending token and opens the modal for a verify challenge', async () => {
    const { result } = setup();

    await act(() => result.current.begin(verifyStart));

    expect(mocks.setMfaPendingTokens).toHaveBeenCalledWith('pending-tok');
    expect(result.current.modalProps.open).toBe(true);
    expect(mocks.setupMutateAsync).not.toHaveBeenCalled();
  });

  it('offers a passkey only in verify mode', async () => {
    const verify = setup();
    await act(() => verify.result.current.begin({ ...verifyStart, passkeyAvailable: true }));
    expect(verify.result.current.modalProps.onPasskeyVerify).toBeDefined();

    const noPasskey = setup();
    await act(() => noPasskey.result.current.begin(verifyStart));
    expect(noPasskey.result.current.modalProps.onPasskeyVerify).toBeUndefined();

    const enrollment = setup();
    await act(() => enrollment.result.current.begin({ ...verifyStart, mode: 'setup', passkeyAvailable: true }));
    expect(enrollment.result.current.modalProps.onPasskeyVerify).toBeUndefined();
  });

  it('starts enrollment in setup mode and exposes the QR data', async () => {
    const { result } = setup();

    await act(() => result.current.begin({ ...verifyStart, mode: 'setup' }));

    expect(mocks.setupMutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.modalProps).toMatchObject({ open: true, qrCodeUrl: 'qr', manualEntryKey: 'KEY' });
  });

  it('ends the sign-in as a cancelled setup when enrollment cannot start', async () => {
    mocks.setupMutateAsync.mockRejectedValue(new Error('setup down'));
    const { result, onCancel } = setup();

    await act(() => result.current.begin({ ...verifyStart, mode: 'setup' }));

    expect(mocks.toastError).toHaveBeenCalledWith('setup down');
    expect(mocks.resetTokens).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('setup');
    expect(result.current.modalProps.open).toBe(false);
  });
});

describe('useMfaChallenge verification', () => {
  it('never remembers the device unless the caller allows it', async () => {
    const { result, onComplete } = setup({ allowRememberDevice: false });
    await act(() => result.current.begin(verifyStart));

    await act(() => result.current.modalProps.onVerify('123456', true));

    expect(mocks.verifyMutateAsync).toHaveBeenCalledWith({ token: '123456', rememberDevice: false });
    expect(mocks.setVerifiedSession).toHaveBeenCalledWith('full-access');
    expect(mocks.resetRefreshCoordinator).toHaveBeenCalled();
    expect(mocks.resetSessionBootstrap).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(session);
    expect(result.current.modalProps.open).toBe(false);
  });

  it('forwards the remember choice when the caller allows it', async () => {
    const { result } = setup({ allowRememberDevice: true });
    await act(() => result.current.begin(verifyStart));

    await act(() => result.current.modalProps.onVerify('123456', true));

    expect(mocks.verifyMutateAsync).toHaveBeenCalledWith({ token: '123456', rememberDevice: true });
  });

  it('verifies enrollment through the setup route', async () => {
    const { result, onComplete } = setup();
    await act(() => result.current.begin({ ...verifyStart, mode: 'setup' }));

    await act(() => result.current.modalProps.onVerify('654321', false));

    expect(mocks.verifySetupMutateAsync).toHaveBeenCalledWith({ token: '654321' });
    expect(mocks.verifyMutateAsync).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(session);
  });

  it('abandons the pending sign-in when the modal is cancelled', async () => {
    const { result, onCancel } = setup();
    await act(() => result.current.begin(verifyStart));

    act(() => result.current.modalProps.onCancel?.());

    expect(mocks.resetTokens).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('verify');
    expect(result.current.modalProps.open).toBe(false);
  });

  it('shows the server message with the attempts remaining and keeps the modal open', async () => {
    mocks.verifyMutateAsync.mockRejectedValue({
      response: { data: { error: 'Invalid code', attemptsRemaining: 2 } },
    });
    const { result, onComplete } = setup();
    await act(() => result.current.begin(verifyStart));

    await act(() => result.current.modalProps.onVerify('000000', false));

    expect(result.current.modalProps.error).toBe('Invalid code (2 attempts remaining)');
    expect(result.current.modalProps.open).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('refuses a response without an access token and never completes', async () => {
    mocks.verifyMutateAsync.mockResolvedValue({ user: { id: 'u1' } });
    const { result, onComplete } = setup();
    await act(() => result.current.begin(verifyStart));

    await act(() => result.current.modalProps.onVerify('123456', false));

    expect(result.current.modalProps.error).toBe('MFA verification returned no session');
    expect(mocks.setVerifiedSession).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
