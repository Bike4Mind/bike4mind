import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: toastError, success: vi.fn() } }));

// The interceptor tags a dismissed verification prompt with a private symbol; stand in a marker.
const CANCELLED = 'verification-dismissed';
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => error instanceof Error && error.message === CANCELLED,
}));

let mockCurrentUser: Record<string, unknown> = {};
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mockCurrentUser, refreshUser: vi.fn() }),
}));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ settings: { enforceMFA: 'false' }, isLoading: false }),
}));

// Every mutation fails with whatever error the test queued, through the component's real onError.
let mockMutationError: Error = new Error('unset');
const failingMutation = () => ({
  mutate: (_variables: unknown, options?: { onError?: (error: Error) => void }) =>
    options?.onError?.(mockMutationError),
  isPending: false,
});
vi.mock('@client/app/hooks/data/mfa', () => ({
  useSetupMFA: () => failingMutation(),
  useVerifyMFASetup: () => failingMutation(),
  useDisableMFA: () => failingMutation(),
  useRegenerateBackupCodes: () => failingMutation(),
  useCancelMFASetup: () => failingMutation(),
  useMFAStatus: () => ({ data: { enabled: true, backupCodesCount: 3 }, isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@client/app/components/common/MFAModal', () => ({ default: () => null }));
vi.mock('./PasskeysSection', () => ({ default: () => null }));
vi.mock('./TrustedDevicesSection', () => ({ default: () => null }));

import MFASection from './MFASection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={new QueryClient()}>
        <MFASection />
      </QueryClientProvider>
    </CssVarsProvider>
  );

describe('MFASection - dismissed verification prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('enable MFA', () => {
    beforeEach(() => {
      mockCurrentUser = { mfa: null };
    });

    it('does not toast an error when the prompt was dismissed', () => {
      mockMutationError = new Error(CANCELLED);
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-enable-btn'));
      expect(toastError).not.toHaveBeenCalled();
    });

    it('toasts the error for any other failure', () => {
      mockMutationError = new Error('setup failed');
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-enable-btn'));
      expect(toastError).toHaveBeenCalledWith('setup failed');
    });
  });

  describe('with MFA already enabled', () => {
    beforeEach(() => {
      mockCurrentUser = { mfa: { totpEnabled: true } };
    });

    it('does not toast an error when disabling MFA is dismissed', () => {
      mockMutationError = new Error(CANCELLED);
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-disable-btn'));
      fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
      expect(toastError).not.toHaveBeenCalled();
    });

    it('toasts the error when disabling MFA fails for another reason', () => {
      mockMutationError = new Error('disable failed');
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-disable-btn'));
      fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
      expect(toastError).toHaveBeenCalledWith('disable failed');
    });

    it('does not toast an error when regenerating backup codes is dismissed', () => {
      mockMutationError = new Error(CANCELLED);
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-regenerate-backup-codes-btn'));
      fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
      expect(toastError).not.toHaveBeenCalled();
    });

    it('toasts the error when regenerating backup codes fails for another reason', () => {
      mockMutationError = new Error('regenerate failed');
      renderSection();
      fireEvent.click(screen.getByTestId('mfa-regenerate-backup-codes-btn'));
      fireEvent.click(screen.getByTestId('confirm-modal-confirm-btn'));
      expect(toastError).toHaveBeenCalledWith('regenerate failed');
    });
  });
});
