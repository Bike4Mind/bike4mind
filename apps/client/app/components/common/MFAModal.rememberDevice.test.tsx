import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MFAModal from './MFAModal';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('next/image', () => ({ default: (props: any) => <img {...props} alt={props.alt} /> }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

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

const CHECKBOX = 'mfa-modal-remember-device-checkbox';

beforeEach(() => vi.clearAllMocks());

describe('MFAModal "remember this device"', () => {
  it('is hidden unless the server allows trusted devices', () => {
    renderModal({ allowRememberDevice: false });
    expect(screen.queryByTestId(CHECKBOX)).toBeNull();
  });

  it('is offered at the verification step when allowed', () => {
    renderModal({ allowRememberDevice: true });
    expect(screen.getByTestId(CHECKBOX)).toBeTruthy();
    expect(screen.getByText(/Remember this device for 30 days/i)).toBeTruthy();
  });

  it('is never offered during MFA setup, where there is no factor to skip yet', () => {
    renderModal({ allowRememberDevice: true, title: 'Set Up Multi-Factor Authentication' });
    expect(screen.queryByTestId(CHECKBOX)).toBeNull();
  });

  it('defaults to unchecked, so the trust is strictly opt-in', () => {
    const { onVerify } = renderModal({ allowRememberDevice: true });

    fireEvent.change(screen.getByTestId('mfa-modal-code-input').querySelector('input')!, {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('mfa-modal-verify-btn'));

    expect(onVerify).toHaveBeenCalledWith('123456', false);
  });

  it('passes the opt-in through to the verify handler when checked', () => {
    const { onVerify } = renderModal({ allowRememberDevice: true });

    fireEvent.change(screen.getByTestId('mfa-modal-code-input').querySelector('input')!, {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId(CHECKBOX).querySelector('input')!);
    fireEvent.click(screen.getByTestId('mfa-modal-verify-btn'));

    expect(onVerify).toHaveBeenCalledWith('123456', true);
  });

  it('reports false when the checkbox is not rendered, even if it was once ticked', () => {
    const { onVerify } = renderModal({ allowRememberDevice: false });

    fireEvent.change(screen.getByTestId('mfa-modal-code-input').querySelector('input')!, {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('mfa-modal-verify-btn'));

    expect(onVerify).toHaveBeenCalledWith('123456', false);
  });
});
