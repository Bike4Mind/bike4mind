import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockUsePasskeys = vi.fn();
const mockRegister = vi.fn();
const mockRemove = vi.fn();
const mockSupported = vi.fn(() => true);

vi.mock('@client/app/hooks/data/passkeys', () => ({
  usePasskeys: () => mockUsePasskeys(),
  useRegisterPasskey: () => ({ mutate: mockRegister, isPending: false }),
  useRemovePasskey: () => ({ mutate: mockRemove, isPending: false, variables: undefined }),
  passkeysSupported: () => mockSupported(),
  describePasskeyError: (_e: unknown, fallback: string) => fallback,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PasskeysSection from './PasskeysSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSection = (enabled = true) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PasskeysSection enabled={enabled} />
    </CssVarsProvider>
  );

const PASSKEY = {
  id: 'pk-1',
  name: 'MacBook',
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: '2026-06-15T00:00:00.000Z',
  lastUsedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSupported.mockReturnValue(true);
  mockUsePasskeys.mockReturnValue({ data: [], isLoading: false });
});

describe('PasskeysSection', () => {
  it('renders nothing while MFA is off', () => {
    renderSection(false);
    expect(screen.queryByTestId('passkeys-section')).toBeNull();
  });

  it('enrolls a passkey under the typed name without collecting a code', () => {
    renderSection();
    fireEvent.change(screen.getByTestId('passkey-name-input'), { target: { value: '  Phone ' } });
    fireEvent.click(screen.getByTestId('passkey-add-btn'));
    expect(mockRegister).toHaveBeenCalledWith({ name: 'Phone' }, expect.any(Object));
  });

  it('has no authenticator code field', () => {
    renderSection();
    expect(screen.queryByTestId('passkey-code-input')).toBeNull();
  });

  it('lists enrolled passkeys and removes one by id', () => {
    mockUsePasskeys.mockReturnValue({ data: [PASSKEY], isLoading: false });
    renderSection();
    expect(screen.getByText('MacBook')).toBeTruthy();
    fireEvent.click(screen.getByTestId('passkey-remove-btn-pk-1'));
    expect(mockRemove).toHaveBeenCalledWith({ id: 'pk-1' }, expect.any(Object));
  });

  it('explains instead of offering enrollment when the browser lacks WebAuthn', () => {
    mockSupported.mockReturnValue(false);
    renderSection();
    expect(screen.getByTestId('passkeys-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('passkey-add-btn')).toBeNull();
  });
});
