import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { toast } from 'sonner';
import MFAModal from './MFAModal';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/image', () => ({ default: (props: any) => <img {...props} alt={props.alt} /> }));
vi.mock('@client/app/hooks/data/passkeys', () => ({ passkeysSupported: () => true }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const BACKUP_CODES = Array.from({ length: 10 }, (_, i) => `ABCDE${i}0000`.slice(0, 10));

const renderModal = (props: Partial<React.ComponentProps<typeof MFAModal>> = {}) => {
  const onVerify = vi.fn();
  render(
    <TestWrapper>
      <MFAModal
        open
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onVerify={onVerify}
        title="Multi-Factor Authentication Required"
        showVerify
        {...props}
      />
    </TestWrapper>
  );
  return { onVerify };
};

const renderSetup = (props: Partial<React.ComponentProps<typeof MFAModal>> = {}) =>
  renderModal({
    mode: 'setup',
    title: 'Set Up Multi-Factor Authentication',
    qrCodeUrl: 'data:image/png;base64,AAAA',
    manualEntryKey: 'JBSWY3DPEHPK3PXP',
    backupCodes: BACKUP_CODES,
    ...props,
  });

const codeInput = () => screen.getByTestId('mfa-modal-code-input').querySelector('input')!;
const paste = (text: string) => fireEvent.paste(codeInput(), { clipboardData: { getData: () => text } });

beforeEach(() => vi.clearAllMocks());

describe('MFAModal layout', () => {
  it('caps the dialog to the viewport and scrolls its content, so a tall setup stays reachable', () => {
    renderSetup();
    const style = window.getComputedStyle(screen.getByTestId('mfa-modal-content'));
    expect(style.maxHeight).toMatch(/vh/);
    expect(style.overflowY).toBe('auto');
  });

  it('is exposed to assistive tech as a modal dialog named by its title', () => {
    renderSetup();
    const dialog = screen.getByRole('dialog', { name: 'Set Up Multi-Factor Authentication' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });
});

describe('MFAModal mode', () => {
  it('uses setup behavior from the mode prop, whatever the title says', () => {
    renderModal({
      mode: 'setup',
      title: 'Enable two-step sign-in',
      allowRememberDevice: true,
      onPasskeyVerify: vi.fn(),
    });
    expect(screen.getByTestId('mfa-modal-verify-btn').textContent).toBe('Verify & Enable MFA');
    expect(screen.queryByTestId('mfa-modal-remember-device-checkbox')).toBeNull();
    expect(screen.queryByTestId('mfa-modal-passkey-btn')).toBeNull();
  });

  it('keeps verify behavior when a verify-mode title happens to contain "Set Up"', () => {
    renderModal({ title: 'Set Up complete - verify', allowRememberDevice: true, onPasskeyVerify: vi.fn() });
    expect(screen.getByTestId('mfa-modal-verify-btn').textContent).toBe('Verify');
    expect(screen.getByTestId('mfa-modal-remember-device-checkbox')).toBeTruthy();
    expect(screen.getByTestId('mfa-modal-passkey-btn')).toBeTruthy();
  });
});

describe('MFAModal copy backup codes', () => {
  const mockClipboard = (writeText: () => Promise<void>) =>
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  it('confirms the copy only when the clipboard write succeeds', async () => {
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    renderSetup();
    fireEvent.click(screen.getByText('Copy All'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Backup codes copied to clipboard'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports an error instead of a false success when the clipboard write fails', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    renderSetup();
    fireEvent.click(screen.getByText('Copy All'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('MFAModal paste', () => {
  it('extracts the code from a labelled paste in setup mode', () => {
    renderSetup();
    paste('Code: 123456');
    expect(codeInput().value).toBe('123456');
    expect(screen.queryByTestId('mfa-modal-paste-hint')).toBeNull();
  });

  it('extracts a backup code from a labelled paste in verify mode', () => {
    renderModal();
    paste('Backup code: ABCD234567');
    expect(codeInput().value).toBe('ABCD234567');
  });

  it('leaves the input alone and shows the setup hint when no code is in the paste', () => {
    const { onVerify } = renderSetup();
    fireEvent.change(codeInput(), { target: { value: '12' } });
    paste('not a code at all');
    expect(codeInput().value).toBe('12');
    expect(screen.getByTestId('mfa-modal-paste-hint').textContent).toBe(
      'Paste or enter the 6-digit code from your authenticator app.'
    );
    expect(onVerify).not.toHaveBeenCalled();

    fireEvent.change(codeInput(), { target: { value: '123' } });
    expect(screen.queryByTestId('mfa-modal-paste-hint')).toBeNull();
  });

  it('shows the verify hint when no code is in the paste', () => {
    const { onVerify } = renderModal();
    paste('nothing useful here!');
    expect(codeInput().value).toBe('');
    expect(screen.getByTestId('mfa-modal-paste-hint').textContent).toBe(
      'Paste or enter a 6-digit code or 10-character backup code.'
    );
    expect(onVerify).not.toHaveBeenCalled();
  });

  it('prefers an embedded 6-digit code over a 10-letter label word in verify mode', () => {
    renderModal();
    paste('Enrollment code: 123456');
    expect(codeInput().value).toBe('123456');
  });

  it('clears the hint once a later paste is usable', () => {
    renderSetup();
    paste('not a code at all');
    expect(screen.getByTestId('mfa-modal-paste-hint')).toBeTruthy();
    paste('123456');
    expect(codeInput().value).toBe('123456');
    expect(screen.queryByTestId('mfa-modal-paste-hint')).toBeNull();
  });

  it('accepts a plain 6-digit or 10-character paste as before', () => {
    renderModal();
    paste('654321');
    expect(codeInput().value).toBe('654321');
    paste('ABCDE23456');
    expect(codeInput().value).toBe('ABCDE23456');
  });

  it('accepts a plain or space-grouped 6-digit paste in setup mode', () => {
    renderSetup();
    paste('654321');
    expect(codeInput().value).toBe('654321');
    paste('123 456');
    expect(codeInput().value).toBe('123456');
    paste('123-456');
    expect(codeInput().value).toBe('123456');
    paste('987\t654\n');
    expect(codeInput().value).toBe('987654');
  });

  it('rejects a short non-code paste in setup mode', () => {
    renderSetup();
    paste('hello');
    expect(codeInput().value).toBe('');
    expect(screen.getByTestId('mfa-modal-paste-hint').textContent).toBe(
      'Paste or enter the 6-digit code from your authenticator app.'
    );
    paste('abcdef');
    expect(codeInput().value).toBe('');
    paste('1234567');
    expect(codeInput().value).toBe('');
    paste('ABCDE23456');
    expect(codeInput().value).toBe('');
    expect(screen.getByTestId('mfa-modal-verify-btn').hasAttribute('disabled')).toBe(true);
  });

  it('rejects a short non-code paste in verify mode', () => {
    const { onVerify } = renderModal();
    paste('hello world');
    expect(codeInput().value).toBe('');
    expect(screen.getByTestId('mfa-modal-paste-hint').textContent).toBe(
      'Paste or enter a 6-digit code or 10-character backup code.'
    );
    expect(onVerify).not.toHaveBeenCalled();
  });
});
