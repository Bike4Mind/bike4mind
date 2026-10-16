import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MfaCard from './MfaCard';

const mutation = { mutate: vi.fn(), isPending: false };
const setupMutation = { mutate: vi.fn(), isPending: false };
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: toastError, success: vi.fn() } }));

// The interceptor tags a dismissed verification prompt with a private symbol; stand in a marker.
const CANCELLED = 'verification-dismissed';
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => error instanceof Error && error.message === CANCELLED,
}));

let mfaEnabled = false;
let backupCodesCount = 0;
// Separate handles so a test can fail one MFA mutation without the others seeing it.
const disableMutation = { mutate: vi.fn(), isPending: false };
const regenerateMutation = { mutate: vi.fn(), isPending: false };

vi.mock('@client/app/hooks/data/mfa', () => ({
  useMFAStatus: () => ({ data: mfaEnabled ? { enabled: true, backupCodesCount } : undefined }),
  useSetupMFA: () => setupMutation,
  useVerifyMFASetup: () => mutation,
  useCancelMFASetup: () => mutation,
  useDisableMFA: () => disableMutation,
  useRegenerateBackupCodes: () => regenerateMutation,
}));

// Admin enforcement drives whether the card offers Disable at all.
let enforceMFA = 'false';
let authedSettingsLoaded = true;
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ settings: { enforceMFA }, authedSettingsLoaded }),
}));
const mfaModalProps: { onVerify?: (token: string) => void } = {};
vi.mock('@client/app/components/common/MFAModal', () => ({
  default: (props: { onVerify: (token: string) => void }) => {
    mfaModalProps.onVerify = props.onVerify;
    return null;
  },
}));
const invalidateQueries = vi.fn();
const refreshUser = vi.fn();
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ refreshUser }) }));
vi.mock('./PasskeysSection', () => ({
  default: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="passkeys-section-stub" data-enabled={`${enabled}`} />
  ),
}));
vi.mock('./TrustedDevicesSection', () => ({
  default: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="trusted-devices-section-stub" data-enabled={`${enabled}`} />
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MfaCard />
    </CssVarsProvider>
  );

describe('MfaCard sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaEnabled = false;
    enforceMFA = 'false';
    authedSettingsLoaded = true;
  });

  it.each(['passkeys-section-stub', 'trusted-devices-section-stub'])('mounts %s, disabled while MFA is off', testId => {
    renderCard();
    expect(screen.getByTestId(testId).getAttribute('data-enabled')).toBe('false');
  });

  it.each(['passkeys-section-stub', 'trusted-devices-section-stub'])('enables %s once MFA is on', testId => {
    mfaEnabled = true;
    renderCard();
    expect(screen.getByTestId(testId).getAttribute('data-enabled')).toBe('true');
  });

  it('refreshes MFA status after enabling MFA so the sections appear without reopening', () => {
    // Fire onSuccess for the setup call (opens the modal) and then the verify call.
    const succeed = (_vars: unknown, opts?: { onSuccess?: (data: object) => void }) => opts?.onSuccess?.({});
    setupMutation.mutate.mockImplementationOnce(succeed);
    mutation.mutate.mockImplementationOnce(succeed);
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    act(() => mfaModalProps.onVerify?.('123456'));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mfa', 'status'] });
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });
});

describe('MfaCard - disabled MFA actions and enforcement', () => {
  // Drive the component's real onError by failing the mocked mutation with the given error.
  const failWith = (target: typeof disableMutation, error: Error) =>
    target.mutate.mockImplementation((_variables: unknown, options: { onError: (e: Error) => void }) =>
      options.onError(error)
    );
  const succeedWith = (target: typeof regenerateMutation, data: object) =>
    target.mutate.mockImplementation((_variables: unknown, options: { onSuccess: (d: object) => void }) =>
      options.onSuccess(data)
    );

  beforeEach(() => {
    vi.clearAllMocks();
    disableMutation.mutate.mockReset();
    regenerateMutation.mutate.mockReset();
    mfaEnabled = true;
    backupCodesCount = 0;
    enforceMFA = 'false';
    authedSettingsLoaded = true;
  });

  it('offers Disable once MFA is on and not enforced', () => {
    renderCard();
    expect(screen.getByTestId('settings-disable-mfa-btn')).toBeTruthy();
  });

  it('hides Disable and flags the status as required when the administrator enforces MFA', () => {
    enforceMFA = 'true';
    renderCard();
    expect(screen.queryByTestId('settings-disable-mfa-btn')).toBeNull();
    expect(screen.getByText('(Required by administrator)')).toBeTruthy();
  });

  it('does not flag enforcement while MFA is off', () => {
    enforceMFA = 'true';
    mfaEnabled = false;
    renderCard();
    expect(screen.queryByText('(Required by administrator)')).toBeNull();
    expect(screen.getByTestId('settings-enable-mfa-btn')).toBeTruthy();
  });

  it('hides Disable until the authenticated settings have loaded', () => {
    authedSettingsLoaded = false;
    renderCard();
    expect(screen.queryByTestId('settings-disable-mfa-btn')).toBeNull();
  });

  it('keeps Regenerate available when the administrator enforces MFA', () => {
    enforceMFA = 'true';
    renderCard();
    expect(screen.getByTestId('settings-regenerate-backup-codes-btn')).toBeTruthy();
  });

  it.each([
    ['settings-disable-mfa-btn', () => disableMutation],
    ['settings-regenerate-backup-codes-btn', () => regenerateMutation],
  ])('does not run the %s mutation until the confirmation is accepted', (buttonTestId, getMutation) => {
    renderCard();
    fireEvent.click(screen.getByTestId(buttonTestId));
    expect(getMutation().mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(getMutation().mutate).toHaveBeenCalledTimes(1);
  });

  it('reports an error instead of success when regeneration returns no codes', () => {
    succeedWith(regenerateMutation, {});
    renderCard();
    fireEvent.click(screen.getByTestId('settings-regenerate-backup-codes-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-backup-codes-copy-btn')).toBeNull();
  });

  it('shows no MFA actions while MFA is off', () => {
    mfaEnabled = false;
    renderCard();
    expect(screen.queryByTestId('settings-disable-mfa-btn')).toBeNull();
    expect(screen.queryByTestId('settings-regenerate-backup-codes-btn')).toBeNull();
    expect(screen.getByTestId('settings-enable-mfa-btn')).toBeTruthy();
  });

  it.each([
    [0, 'Generate Backup Codes'],
    [3, 'Regenerate Backup Codes'],
  ])('labels the backup-codes action for %s existing codes as %s', (count, label) => {
    backupCodesCount = count as number;
    renderCard();
    expect(screen.getByTestId('settings-regenerate-backup-codes-btn').textContent).toBe(label);
  });

  it('disables MFA through the confirmation modal and refreshes the status', () => {
    succeedWith(disableMutation, {});
    renderCard();
    fireEvent.click(screen.getByTestId('settings-disable-mfa-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(disableMutation.mutate).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mfa', 'status'] });
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });

  it('does not toast when disabling MFA is dismissed at the verification prompt', () => {
    failWith(disableMutation, new Error(CANCELLED));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-disable-mfa-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts the error when disabling MFA fails for another reason', () => {
    failWith(disableMutation, new Error('disable failed'));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-disable-mfa-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(toastError).toHaveBeenCalledWith('disable failed');
  });

  it('shows the new codes, with Copy and Download, after regenerating', () => {
    succeedWith(regenerateMutation, { backupCodes: ['aaaa-bbbb'] });
    renderCard();
    fireEvent.click(screen.getByTestId('settings-regenerate-backup-codes-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(screen.getByText('aaaa-bbbb')).toBeTruthy();
    expect(screen.getByTestId('settings-backup-codes-copy-btn')).toBeTruthy();
    expect(screen.getByTestId('settings-backup-codes-download-btn')).toBeTruthy();
  });

  it('does not toast when regenerating backup codes is dismissed at the verification prompt', () => {
    failWith(regenerateMutation, new Error(CANCELLED));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-regenerate-backup-codes-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts the error when regenerating backup codes fails for another reason', () => {
    failWith(regenerateMutation, new Error('regenerate failed'));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-regenerate-backup-codes-btn'));
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
    expect(toastError).toHaveBeenCalledWith('regenerate failed');
  });
});

describe('MfaCard - enable MFA with a dismissed verification prompt', () => {
  // Fail the mocked setup mutation so the component's real onError runs.
  const failSetupWith = (error: Error) =>
    setupMutation.mutate.mockImplementation((_variables: unknown, options: { onError: (e: Error) => void }) =>
      options.onError(error)
    );

  beforeEach(() => {
    vi.clearAllMocks();
    setupMutation.mutate.mockReset();
    mfaEnabled = false;
  });

  it('does not toast an error when the prompt was dismissed', () => {
    failSetupWith(new Error(CANCELLED));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-enable-mfa-btn'));
    expect(setupMutation.mutate).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts the error for any other failure', () => {
    failSetupWith(new Error('setup failed'));
    renderCard();
    fireEvent.click(screen.getByTestId('settings-enable-mfa-btn'));
    expect(toastError).toHaveBeenCalledWith('setup failed');
  });
});
