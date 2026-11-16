import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MFAModal from './MFAModal';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/image', () => ({ default: (props: any) => <img {...props} alt={props.alt} /> }));

const mockPasskeysSupported = vi.fn(() => true);
vi.mock('@client/app/hooks/data/passkeys', () => ({ passkeysSupported: () => mockPasskeysSupported() }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = (props: Partial<React.ComponentProps<typeof MFAModal>> = {}) =>
  render(
    <TestWrapper>
      <MFAModal
        open
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onVerify={vi.fn()}
        title="Multi-Factor Authentication Required"
        showVerify
        {...props}
      />
    </TestWrapper>
  );

const PASSKEY_BTN = 'mfa-modal-passkey-btn';

beforeEach(() => {
  vi.clearAllMocks();
  mockPasskeysSupported.mockReturnValue(true);
});

describe('MFAModal passkey option', () => {
  it('is hidden when the user has no passkey to offer', () => {
    renderModal();
    expect(screen.queryByTestId(PASSKEY_BTN)).toBeNull();
  });

  it('runs the passkey ceremony, carrying the remember-device opt-in', () => {
    const onPasskeyVerify = vi.fn();
    renderModal({ onPasskeyVerify, allowRememberDevice: true });

    fireEvent.click(screen.getByTestId('mfa-modal-remember-device-checkbox').querySelector('input')!);
    fireEvent.click(screen.getByTestId(PASSKEY_BTN));

    expect(onPasskeyVerify).toHaveBeenCalledWith(true);
  });

  it('is never offered during MFA setup', () => {
    renderModal({ onPasskeyVerify: vi.fn(), mode: 'setup', title: 'Set Up Multi-Factor Authentication' });
    expect(screen.queryByTestId(PASSKEY_BTN)).toBeNull();
  });

  it('is hidden in a browser without WebAuthn, leaving the code entry', () => {
    mockPasskeysSupported.mockReturnValue(false);
    renderModal({ onPasskeyVerify: vi.fn() });
    expect(screen.queryByTestId(PASSKEY_BTN)).toBeNull();
    expect(screen.getByTestId('mfa-modal-code-input')).toBeTruthy();
  });

  it('locks the code entry while a passkey ceremony is in flight', () => {
    renderModal({ onPasskeyVerify: vi.fn(), passkeyLoading: true });
    expect(screen.getByTestId('mfa-modal-code-input').querySelector('input')!.disabled).toBe(true);
  });
});

describe('MFAModal passkey enrollment (setup mode)', () => {
  const setupProps = { mode: 'setup' as const, title: 'Set Up Multi-Factor Authentication' };

  it('offers enrolling a passkey instead of an authenticator app', () => {
    const onPasskeyEnroll = vi.fn();
    renderModal({ ...setupProps, onPasskeyEnroll });

    fireEvent.click(screen.getByTestId('mfa-modal-passkey-enroll-btn'));

    expect(onPasskeyEnroll).toHaveBeenCalledTimes(1);
  });

  it('hides the enroll button in a browser without WebAuthn', () => {
    mockPasskeysSupported.mockReturnValue(false);
    renderModal({ ...setupProps, onPasskeyEnroll: vi.fn() });
    expect(screen.queryByTestId('mfa-modal-passkey-enroll-btn')).toBeNull();
  });

  it('does not offer enrollment outside setup mode', () => {
    renderModal({ onPasskeyEnroll: vi.fn() });
    expect(screen.queryByTestId('mfa-modal-passkey-enroll-btn')).toBeNull();
  });

  it('shows the backup codes and Continue once enrolled, with the code input gone', () => {
    const onPasskeyEnrollDone = vi.fn();
    renderModal({
      ...setupProps,
      onPasskeyEnroll: vi.fn(),
      passkeyBackupCodes: ['AAAA-1111', 'BBBB-2222'],
      onPasskeyEnrollDone,
    });

    expect(screen.getByTestId('mfa-modal-passkey-enrolled')).toBeTruthy();
    expect(screen.getByText('AAAA-1111')).toBeTruthy();
    expect(screen.queryByTestId('mfa-modal-code-input')).toBeNull();
    expect(screen.queryByTestId('mfa-modal-passkey-enroll-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('mfa-modal-passkey-continue-btn'));
    expect(onPasskeyEnrollDone).toHaveBeenCalledTimes(1);
  });
});
